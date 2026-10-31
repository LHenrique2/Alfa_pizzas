'use strict';

/**
 * github-sync.js
 *
 * Persistencia dos dados da loja usando o proprio GitHub como armazenamento.
 *
 * Motivacao: hospedagens com disco efemero (Render free, Heroku free, etc.)
 * perdem tudo que fica fora do repositorio a cada novo deploy: pedidos
 * recebidos, cardapio editado pelo painel, bairros, taxa de entrega e as fotos
 * enviadas pelo admin.
 *
 * Como funciona:
 *  - Os arquivos de `data/` (exceto o hash da senha) e de `uploads/` sao
 *    espelhados em uma branch separada (padrao: `alpha-data`).
 *  - Essa branch NAO e a branch de deploy, entao salvar um pedido nao
 *    dispara um novo deploy.
 *  - No boot, o servidor restaura os arquivos a partir dessa branch.
 *  - A cada alteracao (pedido novo, cardapio, bairros, foto), o servidor
 *    grava um commit unico com todos os arquivos alterados.
 *
 * Requisitos (variaveis de ambiente):
 *  - GITHUB_TOKEN      token (fine-grained) com permissao Contents: read/write
 *  - GITHUB_REPO       "usuario/repositorio" (ex.: LHenrique2/Alfa_pizzas)
 *  - GITHUB_DATA_BRANCH  branch de dados (padrao: alpha-data)
 *  - GITHUB_DEPLOY_BRANCH branch usada no deploy (padrao: main) - usada para
 *    descobrir se um arquivo do repositorio foi alterado depois do ultimo sync
 *
 * Sem GITHUB_TOKEN/GITHUB_REPO o modulo simplesmente fica desligado.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const API = 'https://api.github.com';
const USER_AGENT = 'alpha-pizzas-sync';

// Arquivos de dados que fazem parte do espelho.
// `data/admin-password.json` NAO entra: e o hash da senha e nunca deve ser versionado.
const DATA_FILES = [
    'data/orders.json',
    'data/menu.json',
    'data/delivery-areas.json',
    'data/store-settings.json'
];

function gitBlobSha(buffer) {
    const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
    return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

function toBase64(buffer) {
    return buffer.toString('base64');
}

class GitHubSync {
    constructor(options) {
        this.token = options.token || '';
        this.repo = options.repo || '';
        this.branch = options.branch || 'alpha-data';
        this.deployBranch = options.deployBranch || '';
        this.resolvedDeployBranch = this.deployBranch || 'main';
        this.root = options.root;
        this.dataDir = options.dataDir;
        this.uploadDir = options.uploadDir;
        this.log = options.log || console.log;

        this.timer = null;
        this.pending = null;
        this.state = {
            enabled: Boolean(this.token && this.repo),
            lastSyncAt: null,
            lastError: null,
            restorable: false
        };
    }

    get enabled() {
        return this.state.enabled;
    }

    logInfo(message) {
        this.log(`[github-sync] ${message}`);
    }

    logError(message, error) {
        const detail = error && error.message ? ` - ${error.message}` : '';
        this.state.lastError = `${message}${detail}`;
        this.log(`[github-sync] ERRO: ${message}${detail}`);
    }

    async api(endpoint, options = {}) {
        const headers = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': USER_AGENT,
            ...(options.headers || {})
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;

        const response = await fetch(`${API}${endpoint}`, { ...options, headers });
        const text = await response.text();
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch {
                payload = { raw: text };
            }
        }
        if (!response.ok) {
            const message = payload && payload.message ? payload.message : `HTTP ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    // ---------------------------------------------------------------- helpers

    repoPath(suffix) {
        return `/repos/${this.repo}${suffix}`;
    }

    async getRef(branch) {
        try {
            const payload = await this.api(this.repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`));
            return payload.object ? payload.object.sha : null;
        } catch (error) {
            if (error.status === 404) return null;
            throw error;
        }
    }

    async getCommit(sha) {
        const payload = await this.api(this.repoPath(`/git/commits/${sha}`));
        return {
            sha: payload.sha,
            treeSha: payload.tree ? payload.tree.sha : null,
            date: payload.commit && payload.commit.committer ? payload.commit.committer.date : null
        };
    }

    async getTree(treeSha) {
        const payload = await this.api(this.repoPath(`/git/trees/${treeSha}?recursive=1`));
        const entries = new Map();
        for (const node of payload.tree || []) {
            if (node.type === 'blob') entries.set(node.path, node.sha);
        }
        return entries;
    }

    async getBlob(sha) {
        const payload = await this.api(this.repoPath(`/git/blobs/${sha}`));
        return Buffer.from(payload.content || '', 'base64');
    }

    async createBlob(buffer) {
        const payload = await this.api(this.repoPath('/git/blobs'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: toBase64(buffer), encoding: 'base64' })
        });
        return payload.sha;
    }

    async createTree(baseTreeSha, entries) {
        const payload = await this.api(this.repoPath('/git/trees'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_tree: baseTreeSha,
                tree: entries.map(entry => ({
                    path: entry.path,
                    mode: '100644',
                    type: 'blob',
                    sha: entry.sha
                }))
            })
        });
        return payload.sha;
    }

    async createCommit(treeSha, message, parentSha) {
        const payload = await this.api(this.repoPath('/git/commits'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
        });
        return payload.sha;
    }

    async updateRef(branch, sha) {
        await this.api(this.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha, force: false })
        });
    }

    async lastChangeDate(filePath) {
        try {
            const payload = await this.api(
                this.repoPath(`/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(this.resolvedDeployBranch)}&per_page=1`)
            );
            if (!Array.isArray(payload) || payload.length === 0) return null;
            const commit = payload[0];
            return commit.commit && commit.commit.committer ? commit.commit.committer.date : null;
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------- filesystem

    trackedFiles() {
        const files = new Map();

        for (const relative of DATA_FILES) {
            const absolute = path.join(this.root, relative);
            if (fs.existsSync(absolute)) files.set(relative, absolute);
            else {
                const dataFile = path.join(this.dataDir, path.basename(relative));
                if (fs.existsSync(dataFile)) files.set(relative, dataFile);
            }
        }

        let uploads = [];
        try {
            uploads = fs.readdirSync(this.uploadDir, { withFileTypes: true })
                .filter(entry => entry.isFile())
                .map(entry => entry.name);
        } catch {
            uploads = [];
        }
        for (const name of uploads) {
            files.set(`uploads/${name}`, path.join(this.uploadDir, name));
        }

        return files;
    }

    async readSnapshot() {
        const snapshot = new Map();
        for (const [relative, absolute] of this.trackedFiles()) {
            try {
                snapshot.set(relative, await fsp.readFile(absolute));
            } catch {
                // arquivo sumiu entre listar e ler: ignora
            }
        }
        return snapshot;
    }

    async writeLocal(relative, buffer) {
        const absolute = path.join(this.root, relative);
        if (!absolute.startsWith(this.root)) return;
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        const temporaryFile = `${absolute}.${crypto.randomUUID()}.tmp`;
        await fsp.writeFile(temporaryFile, buffer);
        await fsp.rename(temporaryFile, absolute);
    }

    // ---------------------------------------------------------------- restore

    // Descobre em qual branch o site esta sendo publicado (main ou master),
    // para saber se um arquivo do repositorio foi alterado depois do ultimo sync.
    async resolveDeployBranch() {
        if (this.deployBranch) {
            this.resolvedDeployBranch = this.deployBranch;
            return this.resolvedDeployBranch;
        }
        for (const candidate of ['main', 'master']) {
            const sha = await this.getRef(candidate);
            if (sha) {
                this.resolvedDeployBranch = candidate;
                return candidate;
            }
        }
        this.resolvedDeployBranch = 'main';
        return this.resolvedDeployBranch;
    }

    async restore() {
        if (!this.enabled) return;
        try {
            await this.resolveDeployBranch();
            let headSha = await this.getRef(this.branch);
            if (!headSha) {
                const deploySha = await this.getRef(this.resolvedDeployBranch);
                if (!deploySha) {
                    this.logInfo(`Branch ${this.resolvedDeployBranch} nao encontrada; sync ignorado.`);
                    return;
                }
                await this.api(this.repoPath('/git/refs'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ref: `refs/heads/${this.branch}`, sha: deploySha })
                });
                this.logInfo(`Branch ${this.branch} criada a partir de ${this.resolvedDeployBranch}.`);
                headSha = deploySha;
            }

            const head = await this.getCommit(headSha);
            const tree = await this.getTree(head.treeSha);
            const snapshot = await this.readSnapshot();

            let restored = 0;
            let keptLocal = 0;

            // 1) Arquivos que existem na branch de dados: decide quem manda.
            for (const [relative, buffer] of snapshot) {
                const remoteSha = tree.get(relative);
                if (!remoteSha) continue;
                const remoteBuffer = await this.getBlob(remoteSha);
                if (remoteBuffer.equals(buffer)) continue;

                const remoteDate = head.date ? new Date(head.date).getTime() : 0;
                const mainDate = await this.lastChangeDate(relative);
                const mainTime = mainDate ? new Date(mainDate).getTime() : 0;

                if (mainTime > remoteDate) {
                    // O repositorio foi alterado depois do ultimo sync: vale a versao do repo.
                    keptLocal += 1;
                    continue;
                }
                await this.writeLocal(relative, remoteBuffer);
                restored += 1;
            }

            // 2) Arquivos que existem apenas na branch de dados (ex.: fotos novas).
            for (const [relative, remoteSha] of tree) {
                if (!relative.startsWith('uploads/')) continue;
                if (snapshot.has(relative)) continue;
                const remoteBuffer = await this.getBlob(remoteSha);
                await this.writeLocal(relative, remoteBuffer);
                restored += 1;
            }

            this.state.restorable = true;
            this.logInfo(
                `Restauracao concluida: ${restored} arquivo(s) restaurado(s), ${keptLocal} mantidos do repositorio.`
            );

            // 3) Garante que a branch tenha tudo que esta no disco.
            await this.push('sincronizacao inicial');
        } catch (error) {
            this.logError('falha ao restaurar os dados', error);
        }
    }

    // ------------------------------------------------------------------- push

    async push(message) {
        if (!this.enabled) return;
        try {
            let headSha = await this.getRef(this.branch);
            if (!headSha) return;
            let head = await this.getCommit(headSha);
            let tree = await this.getTree(head.treeSha);
            const snapshot = await this.readSnapshot();

            const entries = [];
            for (const [relative, buffer] of snapshot) {
                const localSha = gitBlobSha(buffer);
                if (tree.get(relative) === localSha) continue;
                const blobSha = await this.createBlob(buffer);
                entries.push({ path: relative, sha: blobSha });
            }

            if (entries.length === 0) {
                this.state.lastSyncAt = new Date().toISOString();
                this.state.lastError = null;
                return;
            }

            const treeSha = await this.createTree(head.treeSha, entries);
            const commitSha = await this.createCommit(
                treeSha,
                `dados da loja: ${message} (${entries.length} arquivo(s))`,
                headSha
            );

            try {
                await this.updateRef(this.branch, commitSha);
            } catch (error) {
                // Alguem pode ter enviado dados ao mesmo tempo: refaz com a nova base.
                if (error.status !== 422 && error.status !== 409) throw error;
                headSha = await this.getRef(this.branch);
                head = await this.getCommit(headSha);
                tree = await this.getTree(head.treeSha);
                const retryEntries = [];
                for (const [relative, buffer] of snapshot) {
                    const localSha = gitBlobSha(buffer);
                    if (tree.get(relative) === localSha) continue;
                    const blobSha = await this.createBlob(buffer);
                    retryEntries.push({ path: relative, sha: blobSha });
                }
                const retryTree = await this.createTree(head.treeSha, retryEntries);
                const retryCommit = await this.createCommit(
                    retryTree,
                    `dados da loja: ${message} (${retryEntries.length} arquivo(s))`,
                    headSha
                );
                await this.updateRef(this.branch, retryCommit);
            }

            this.state.lastSyncAt = new Date().toISOString();
            this.state.lastError = null;
            this.logInfo(`Sync concluido: ${entries.length} arquivo(s) gravado(s) em ${this.branch}.`);
        } catch (error) {
            this.logError('falha ao gravar os dados no GitHub', error);
        }
    }

    schedule(message) {
        if (!this.enabled) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.push(message);
        }, 1500);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    async flush(message) {
        if (!this.enabled) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        await this.push(message);
    }

    status() {
        return {
            enabled: this.state.enabled,
            branch: this.branch,
            deployBranch: this.resolvedDeployBranch,
            lastSyncAt: this.state.lastSyncAt,
            lastError: this.state.lastError
        };
    }
}

module.exports = { GitHubSync, DATA_FILES };
