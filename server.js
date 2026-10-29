const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;

function loadEnvFile() {
    const envFile = path.join(ROOT, '.env');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1] in process.env) continue;
        process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
}

loadEnvFile();

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || 'uploads');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const DELIVERY_AREAS_FILE = path.join(DATA_DIR, 'delivery-areas.json');
const STORE_SETTINGS_FILE = path.join(DATA_DIR, 'store-settings.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.json');
const PORT = Number(process.env.PORT) || 4173;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MINIMUM_ESFIHAS_FOR_DELIVERY = 5;
const sessions = new Map();
const loginAttempts = new Map();
const categories = new Set(['esfihas-salgadas', 'esfihas-doces', 'pizzas', 'calzones', 'adicionais', 'bebidas']);
const SIZE_LABELS = { pequena: 'Pequena', media: 'Média', grande: 'Grande', gg: 'Gigante' };
const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.css': 'text/css; charset=utf-8'
};

function ensureInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function sendJson(response, status, payload, extraHeaders = {}) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    response.end(JSON.stringify(payload));
}

function readJson(request, maxBytes = MAX_JSON_BYTES) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        let tooLarge = false;
        request.on('data', chunk => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (tooLarge) {
                const error = new Error('A requisição excede o tamanho permitido.');
                error.status = 413;
                return reject(error);
            }
            if (size === 0) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                const error = new Error('JSON inválido.');
                error.status = 400;
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

function readCookie(request, name) {
    const cookies = (request.headers.cookie || '').split(';');
    for (const cookie of cookies) {
        const separator = cookie.indexOf('=');
        if (separator < 0) continue;
        if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
    }
    return '';
}

function isAuthenticated(request) {
    const token = readCookie(request, 'alpha_session');
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        sessions.delete(token);
        return false;
    }
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
}

function validImageUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    if (/^\/uploads\/[a-f0-9-]+\.(png|jpg|webp)$/i.test(value)) return true;
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

// O tamanho da pizza nunca vem do cliente: resolvemos pelo id do produto no cardápio.
function resolveOrderSize(orderItem, menuItem) {
    if (!menuItem || menuItem.category !== 'pizzas') return null;
    const candidates = [];
    if (typeof orderItem?.size === 'string') candidates.push(orderItem.size);
    const cartKey = typeof orderItem?.cartKey === 'string' ? orderItem.cartKey : '';
    const fromKey = cartKey.match(/_(pequena|media|grande|gg)(?:_|$)/);
    if (fromKey) candidates.push(fromKey[1]);
    for (const candidate of candidates) {
        if (SIZE_LABELS[candidate]) return candidate;
    }
    return 'media';
}

// Mesma regra de preço do site: tamanho vem do cardápio e o fallback é calculado aqui.
function resolveSizePrice(menuItem, size) {
    const sizes = menuItem.sizes && typeof menuItem.sizes === 'object' ? menuItem.sizes : {};
    const base = Number(menuItem.price) || 0;
    const pequena = Number.isFinite(Number(sizes.pequena)) ? Number(sizes.pequena) : base - 10;
    const media = Number.isFinite(Number(sizes.media)) ? Number(sizes.media) : base;
    const grande = Number.isFinite(Number(sizes.grande)) ? Number(sizes.grande) : base + 10;
    const gg = Number.isFinite(Number(sizes.gg)) ? Number(sizes.gg) : grande + 10;
    const price = { pequena, media, grande, gg }[size];
    return Number.isFinite(price) ? price : media;
}

function validateMenu(items) {
    if (!Array.isArray(items) || items.length > 500) return false;
    const ids = new Set();
    return items.every(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id) ||
            !categories.has(item.category) || typeof item.title !== 'string' ||
            item.title.trim().length === 0 || item.title.length > 120 ||
            typeof item.desc !== 'string' || item.desc.length > 1000 ||
            typeof item.badge !== 'string' || item.badge.length > 60 ||
            (item.available !== undefined && typeof item.available !== 'boolean') ||
            !validImageUrl(item.img) || !Number.isFinite(item.price) || item.price < 0 || item.price > 100000) {
            return false;
        }
        ids.add(item.id);
        if (item.category !== 'pizzas' && item.sizes !== undefined) return false;
        if (item.sizes !== undefined && (!item.sizes || typeof item.sizes !== 'object' || Array.isArray(item.sizes) ||
            !['pequena', 'media', 'grande'].every(size => Number.isFinite(item.sizes[size]) && item.sizes[size] >= 0 && item.sizes[size] <= 100000) ||
            (item.sizes.gg !== undefined && (!Number.isFinite(item.sizes.gg) || item.sizes.gg < 0 || item.sizes.gg > 100000)))) {
            return false;
        }
        return true;
    });
}

async function readMenu() {
    try {
        const value = JSON.parse(await fs.promises.readFile(MENU_FILE, 'utf8'));
        return validateMenu(value) ? value : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeMenu(items) {
    const temporaryFile = `${MENU_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryFile, JSON.stringify(items, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporaryFile, MENU_FILE);
}

async function readOrders() {
    try {
        const content = await fs.promises.readFile(ORDERS_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeOrders(orders) {
    const temporaryFile = `${ORDERS_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryFile, JSON.stringify(orders, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporaryFile, ORDERS_FILE);
}

// Fila de escrita: evita que dois pedidos simultâneos sobrescrevam um ao outro.
let ordersQueue = Promise.resolve();
async function updateOrders(mutator) {
    const task = ordersQueue.then(async () => {
        const orders = await readOrders();
        const result = await mutator(orders);
        await writeOrders(orders);
        return result;
    });
    ordersQueue = task.then(() => undefined, () => undefined);
    return task;
}

function validateDeliveryAreas(areas) {
    if (!Array.isArray(areas) || areas.length > 100) return false;
    const names = new Set();
    return areas.every(area => {
        if (!area || typeof area !== 'object' || Array.isArray(area) ||
            typeof area.name !== 'string' || area.name.trim().length === 0 || area.name.trim().length > 80 ||
            !Number.isFinite(area.fee) || area.fee < 0 || area.fee > 10000) return false;
        const key = area.name.trim().toLocaleLowerCase('pt-BR');
        if (names.has(key)) return false;
        names.add(key);
        return true;
    });
}

async function readDeliveryAreas() {
    try {
        const value = JSON.parse(await fs.promises.readFile(DELIVERY_AREAS_FILE, 'utf8'));
        return validateDeliveryAreas(value) ? value.map(area => ({ name: area.name.trim(), fee: Math.round(area.fee * 100) / 100 })) : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeDeliveryAreas(areas) {
    const normalized = areas.map(area => ({ name: area.name.trim(), fee: Math.round(area.fee * 100) / 100 }));
    const temporaryFile = `${DELIVERY_AREAS_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryFile, JSON.stringify(normalized, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporaryFile, DELIVERY_AREAS_FILE);
}

async function readStoreSettings() {
    try {
        const settings = JSON.parse(await fs.promises.readFile(STORE_SETTINGS_FILE, 'utf8'));
        return { pixKey: typeof settings.pixKey === 'string' ? settings.pixKey : '' };
    } catch (error) {
        if (error.code === 'ENOENT') return { pixKey: '' };
        throw error;
    }
}

async function writeStoreSettings(settings) {
    const temporaryFile = `${STORE_SETTINGS_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporaryFile, STORE_SETTINGS_FILE);
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derivedKey = await scrypt(password, salt, 64);
    return { salt, hash: derivedKey.toString('hex') };
}

async function verifyPassword(password) {
    const record = JSON.parse(await fs.promises.readFile(PASSWORD_FILE, 'utf8'));
    const { hash } = await hashPassword(password, record.salt);
    const expected = Buffer.from(record.hash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function rateLimitKey(request) {
    return request.socket.remoteAddress || 'unknown';
}

function isLoginRateLimited(request) {
    const attempt = loginAttempts.get(rateLimitKey(request));
    if (!attempt || attempt.expiresAt <= Date.now()) {
        loginAttempts.delete(rateLimitKey(request));
        return false;
    }
    return attempt.count >= 5;
}

function recordLoginFailure(request) {
    const key = rateLimitKey(request);
    const attempt = loginAttempts.get(key);
    if (!attempt || attempt.expiresAt <= Date.now()) {
        loginAttempts.set(key, { count: 1, expiresAt: Date.now() + 15 * 60 * 1000 });
        return;
    }
    attempt.count += 1;
}

function clearLoginFailures(request) {
    loginAttempts.delete(rateLimitKey(request));
}

function validImageBytes(mime, buffer) {
    if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    return false;
}

function setSecurityHeaders(response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https: http:",
        "connect-src 'self'",
        "frame-src https://www.google.com https://maps.google.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    ].join('; '));
}

async function handleApi(request, response, url) {
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /api/health') return sendJson(response, 200, { status: 'ok' });
    if (route === 'GET /api/menu') {
        return sendJson(response, 200, { items: await readMenu(), initialized: fs.existsSync(MENU_FILE) });
    }
    if (route === 'GET /api/delivery-areas') {
        return sendJson(response, 200, { areas: await readDeliveryAreas() });
    }
    if (route === 'GET /api/store-settings') {
        return sendJson(response, 200, await readStoreSettings());
    }

    if (route === 'POST /api/orders') {
        const body = await readJson(request, 1024 * 1024);
        if (!body || typeof body !== 'object' || !Array.isArray(body.items) || body.items.length === 0) {
            return sendJson(response, 400, { error: 'O pedido não contém itens válidos.' });
        }
        const deliveryArea = typeof body.deliveryArea === 'string' ? body.deliveryArea.trim() : '';
        const deliveryAreas = await readDeliveryAreas();
        const selectedArea = deliveryAreas.find(area => area.name.toLocaleLowerCase('pt-BR') === deliveryArea.toLocaleLowerCase('pt-BR'));
        if (!selectedArea) return sendJson(response, 400, { error: 'Selecione um bairro com entrega disponível.' });
        const customerName = typeof body.customerName === 'string' ? body.customerName.trim().slice(0, 100) : 'Cliente';
        const rawPhone = typeof body.customerPhone === 'string' ? body.customerPhone.trim() : '';
        const phoneDigits = rawPhone.replace(/\D/g, '');
        const hasInternationalPrefix = rawPhone.startsWith('+');
        const customerPhone = hasInternationalPrefix
            ? phoneDigits.length >= 12 && phoneDigits.length <= 13 && phoneDigits.startsWith('55') ? phoneDigits : ''
            : phoneDigits.length === 10 || phoneDigits.length === 11
                ? `55${phoneDigits}`
                : phoneDigits.length >= 12 && phoneDigits.length <= 13 && phoneDigits.startsWith('55')
                    ? phoneDigits
                    : '';
        if (!customerPhone) return sendJson(response, 400, { error: 'Informe um telefone com DDD válido para receber atualizações pelo WhatsApp.' });
        if (body.whatsappConsent !== true) return sendJson(response, 400, { error: 'É necessário autorizar o envio de atualizações do pedido pelo WhatsApp.' });
        const customerAddress = typeof body.customerAddress === 'string' ? body.customerAddress.trim().slice(0, 300) : '';
        const paymentMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod.trim().slice(0, 50) : 'Não informada';
        if (paymentMethod === 'Pix' && !(await readStoreSettings()).pixKey) {
            return sendJson(response, 400, { error: 'A loja ainda não configurou o recebimento via Pix.' });
        }
        const menu = await readMenu();
        const menuById = new Map(menu.map(menuItem => [menuItem.id, menuItem]));
        const unavailableItem = body.items.find(orderItem =>
            menu.some(menuItem => menuItem.id === orderItem?.id && menuItem.available === false));
        if (unavailableItem) {
            return sendJson(response, 400, { error: 'Um ou mais produtos do pedido estão esgotados. Atualize o cardápio e tente novamente.' });
        }

        let total = 0;
        const validItems = [];
        for (const orderItem of body.items) {
            const menuItem = menuById.get(Number(orderItem?.id));
            if (!menuItem) {
                return sendJson(response, 400, { error: 'O pedido contém um produto que não está mais no cardápio. Atualize a página e tente novamente.' });
            }
            const qty = Math.max(1, Math.min(99, Number(orderItem.qty) || 1));
            const size = resolveOrderSize(orderItem, menuItem);
            const price = size ? resolveSizePrice(menuItem, size) : Number(menuItem.price);
            if (!Number.isFinite(price) || price < 0) {
                return sendJson(response, 400, { error: `O preço de "${menuItem.title}" não está válido no cardápio. Ajuste o produto no painel.` });
            }
            const title = size ? `${menuItem.title} (${SIZE_LABELS[size]})` : menuItem.title;
            total += price * qty;
            validItems.push({
                id: menuItem.id,
                title,
                qty,
                price,
                category: menuItem.category
            });
        }
        const esfihaCount = validItems
            .filter(item => item.category === 'esfihas-salgadas' || item.category === 'esfihas-doces')
            .reduce((count, item) => count + item.qty, 0);
        if (esfihaCount > 0 && esfihaCount < MINIMUM_ESFIHAS_FOR_DELIVERY) {
            return sendJson(response, 400, { error: `Para incluir esfihas em pedidos para entrega, selecione pelo menos ${MINIMUM_ESFIHAS_FOR_DELIVERY} unidades.` });
        }

        total = Math.round(total * 100) / 100;
        const deliveryFee = selectedArea.fee;
        const newOrder = {
            id: `ALP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            createdAt: new Date().toISOString(),
            status: 'novo', // 'novo' | 'em_preparo' | 'saiu_entrega' | 'concluido' | 'cancelado'
            customerName,
            customerPhone,
            whatsappConsentAt: new Date().toISOString(),
            customerAddress,
            deliveryArea: selectedArea.name,
            paymentMethod,
            items: validItems,
            subtotal: total,
            deliveryFee,
            total: Math.round((total + deliveryFee) * 100) / 100,
            printed: false
        };

        await updateOrders(async (orders) => {
            orders.unshift(newOrder);
            // Manter até os últimos 500 pedidos
            if (orders.length > 500) orders.length = 500;
        });

        return sendJson(response, 201, { success: true, order: newOrder });
    }

    if (route === 'GET /api/admin/session') {
        return sendJson(response, 200, { authenticated: isAuthenticated(request) });
    }

    if (route === 'POST /api/admin/login') {
        if (isLoginRateLimited(request)) return sendJson(response, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
        const body = await readJson(request, 4096);
        const password = typeof body.password === 'string' ? body.password : '';
        if (password.length > 1024 || !(await verifyPassword(password))) {
            recordLoginFailure(request);
            return sendJson(response, 401, { error: 'Senha incorreta.' });
        }
        clearLoginFailures(request);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
        const cookie = `alpha_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
        return sendJson(response, 200, { authenticated: true }, { 'Set-Cookie': cookie });
    }

    if (route === 'POST /api/admin/logout') {
        const token = readCookie(request, 'alpha_session');
        sessions.delete(token);
        return sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': 'alpha_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (url.pathname.startsWith('/api/admin/') && !isAuthenticated(request)) {
        return sendJson(response, 401, { error: 'Autenticação necessária.' });
    }

    if (route === 'GET /api/admin/orders') {
        const orders = await readOrders();
        return sendJson(response, 200, { orders });
    }

    if (route === 'GET /api/admin/delivery-areas') {
        return sendJson(response, 200, { areas: await readDeliveryAreas() });
    }

    if (route === 'GET /api/admin/store-settings') {
        return sendJson(response, 200, await readStoreSettings());
    }

    if (route === 'PUT /api/admin/store-settings') {
        const body = await readJson(request, 4096);
        if (typeof body.pixKey !== 'string' || body.pixKey.trim().length > 160) {
            return sendJson(response, 400, { error: 'Informe uma chave Pix válida (até 160 caracteres).' });
        }
        const settings = { pixKey: body.pixKey.trim() };
        await writeStoreSettings(settings);
        return sendJson(response, 200, settings);
    }

    if (route === 'PUT /api/admin/delivery-areas') {
        const body = await readJson(request, 64 * 1024);
        if (!validateDeliveryAreas(body.areas)) {
            return sendJson(response, 400, { error: 'Confira os bairros, valores e nomes duplicados.' });
        }
        await writeDeliveryAreas(body.areas);
        return sendJson(response, 200, { areas: await readDeliveryAreas() });
    }

    if (route === 'PATCH /api/admin/orders') {
        const body = await readJson(request, 64 * 1024);
        if (!body || typeof body.id !== 'string') {
            return sendJson(response, 400, { error: 'ID do pedido obrigatório.' });
        }
        const updated = await updateOrders(async (orders) => {
            const target = orders.find(o => o.id === body.id);
            if (!target) return null;

            const allowedStatus = ['novo', 'em_preparo', 'saiu_entrega', 'concluido', 'cancelado'];
            const previousStatus = target.status;
            if (typeof body.status === 'string') {
                if (!allowedStatus.includes(body.status)) {
                    const error = new Error('Status de pedido inválido.');
                    error.status = 400;
                    throw error;
                }
                target.status = body.status;
            }
            if (typeof body.printed === 'boolean') {
                target.printed = body.printed;
            }

            const statusChanged = typeof body.status === 'string' && body.status !== previousStatus;
            return { target, statusChanged };
        });
        if (!updated) return sendJson(response, 404, { error: 'Pedido não encontrado.' });
        return sendJson(response, 200, { success: true, order: updated.target, statusChanged: updated.statusChanged });
    }

    if (route === 'DELETE /api/admin/orders') {
        const body = await readJson(request, 64 * 1024);
        if (!body || typeof body.id !== 'string') {
            return sendJson(response, 400, { error: 'ID do pedido obrigatório.' });
        }
        const removed = await updateOrders(async (orders) => {
            const target = orders.find(o => o.id === body.id);
            if (!target) return { error: { status: 404, message: 'Pedido não encontrado.' } };
            if (target.status !== 'concluido') {
                return { error: { status: 400, message: 'Somente pedidos finalizados podem ser excluídos.' } };
            }
            const remaining = orders.filter(o => o.id !== body.id);
            orders.length = 0;
            orders.push(...remaining);
            return { removed: true };
        });
        if (removed.error) return sendJson(response, removed.error.status, { error: removed.error.message });
        return sendJson(response, 200, { success: true });
    }

    if (route === 'PUT /api/admin/menu') {
        const body = await readJson(request);
        if (!validateMenu(body.items)) return sendJson(response, 400, { error: 'O cardápio contém dados inválidos.' });
        await writeMenu(body.items);
        return sendJson(response, 200, { items: body.items });
    }

    if (route === 'POST /api/admin/images') {
        const body = await readJson(request, 7 * 1024 * 1024);
        if (typeof body.dataUrl !== 'string') return sendJson(response, 400, { error: 'Imagem ausente.' });
        const match = body.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match) return sendJson(response, 400, { error: 'Use uma imagem PNG, JPEG ou WebP.' });
        const mime = match[1];
        const content = Buffer.from(match[2], 'base64');
        if (content.length === 0 || content.length > MAX_IMAGE_BYTES || !validImageBytes(mime, content)) {
            return sendJson(response, 400, { error: 'Imagem inválida ou maior que 5 MB.' });
        }
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime];
        const filename = `${crypto.randomUUID()}.${extension}`;
        await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), content, { flag: 'wx', mode: 0o644 });
        return sendJson(response, 201, { url: `/uploads/${filename}` });
    }

    if (route === 'POST /api/admin/password') {
        const body = await readJson(request, 4096);
        const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
        if (!(await verifyPassword(currentPassword))) return sendJson(response, 400, { error: 'Senha atual incorreta.' });
        if (newPassword.length < 12 || newPassword.length > 1024) {
            return sendJson(response, 400, { error: 'A nova senha deve ter entre 12 e 1024 caracteres.' });
        }
        const record = await hashPassword(newPassword);
        await fs.promises.writeFile(PASSWORD_FILE, JSON.stringify(record), { mode: 0o600 });
        sessions.clear();
        return sendJson(response, 200, { changed: true }, { 'Set-Cookie': 'alpha_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    return sendJson(response, 404, { error: 'Rota não encontrada.' });
}

async function serveStatic(request, response, url) {
    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        response.writeHead(400);
        response.end('Bad request');
        return;
    }
    // A página do cliente é única: index.html. O nome antigo continua funcionando por redirecionamento.
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/alpha_pizzas_site.html') {
        response.writeHead(301, { Location: '/index.html', 'Cache-Control': 'no-store' });
        response.end();
        return;
    }

    let filePath;
    if (pathname.startsWith('/uploads/')) {
        const filename = pathname.slice('/uploads/'.length);
        if (!/^[a-f0-9-]+\.(png|jpg|webp)$/i.test(filename)) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }
        filePath = path.join(UPLOAD_DIR, filename);
    } else {
        const allowed = new Set([
            '/index.html', '/admin.html', '/manifest.webmanifest',
            '/service-worker.js', '/logo.png', '/hero-bg.jpg',
            '/icons/icon-192.png', '/icons/icon-512.png'
        ]);
        if (!allowed.has(pathname)) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }
        filePath = path.resolve(ROOT, `.${pathname}`);
        if (!ensureInside(ROOT, filePath)) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }
    }

    try {
        const content = await fs.promises.readFile(filePath);
        response.writeHead(200, {
            'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': pathname === '/service-worker.js' ? 'no-cache' : 'public, max-age=3600'
        });
        if (request.method === 'HEAD') return response.end();
        response.end(content);
    } catch (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500);
        response.end(error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
    }
}

async function main() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });

    if (!fs.existsSync(PASSWORD_FILE)) {
        const generatedPassword = crypto.randomBytes(12).toString('base64url');
        const initialPassword = process.env.ADMIN_PASSWORD || generatedPassword;
        const record = await hashPassword(initialPassword);
        await fs.promises.writeFile(PASSWORD_FILE, JSON.stringify(record), { mode: 0o600 });
        console.log('Senha do painel inicializada.');
        if (!process.env.ADMIN_PASSWORD) {
            console.log('--------------------------------------------------');
            console.log(`Senha inicial do painel: ${initialPassword}`);
            console.log('Guarde-a com segurança e altere pelo painel assim que entrar.');
            console.log('--------------------------------------------------');
        }
    }

    if (!fs.existsSync(MENU_FILE)) {
        const defaultMenuPath = path.join(ROOT, 'data', 'menu.json');
        let initialMenu = [];
        try {
            if (fs.existsSync(defaultMenuPath)) {
                initialMenu = JSON.parse(await fs.promises.readFile(defaultMenuPath, 'utf8'));
            }
        } catch {
            initialMenu = [];
        }
        await fs.promises.writeFile(MENU_FILE, JSON.stringify(initialMenu, null, 2), { mode: 0o600 });
    }

    // Instalações novas precisam dos bairros e da chave Pix: sem isso a loja não aceita pedidos.
    if (!fs.existsSync(DELIVERY_AREAS_FILE)) {
        const defaultAreasPath = path.join(ROOT, 'data', 'delivery-areas.json');
        let initialAreas = [];
        try {
            if (fs.existsSync(defaultAreasPath)) {
                initialAreas = JSON.parse(await fs.promises.readFile(defaultAreasPath, 'utf8'));
            }
        } catch {
            initialAreas = [];
        }
        await fs.promises.writeFile(DELIVERY_AREAS_FILE, JSON.stringify(initialAreas, null, 2), { mode: 0o600 });
    }

    if (!fs.existsSync(STORE_SETTINGS_FILE)) {
        const defaultSettingsPath = path.join(ROOT, 'data', 'store-settings.json');
        let initialSettings = { pixKey: '' };
        try {
            if (fs.existsSync(defaultSettingsPath)) {
                initialSettings = JSON.parse(await fs.promises.readFile(defaultSettingsPath, 'utf8'));
            }
        } catch {
            initialSettings = { pixKey: '' };
        }
        await fs.promises.writeFile(STORE_SETTINGS_FILE, JSON.stringify(initialSettings, null, 2), { mode: 0o600 });
    }

    if (!fs.existsSync(ORDERS_FILE)) {
        await fs.promises.writeFile(ORDERS_FILE, JSON.stringify([], null, 2), { mode: 0o600 });
    }

    const server = http.createServer(async (request, response) => {
        setSecurityHeaders(response);
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        try {
            if (url.pathname.startsWith('/api/')) {
                await handleApi(request, response, url);
                return;
            }
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405, { Allow: 'GET, HEAD' });
                response.end('Method not allowed');
                return;
            }
            await serveStatic(request, response, url);
        } catch (error) {
            if (response.headersSent || response.destroyed) return;
            if (error.status) return sendJson(response, error.status, { error: error.message });
            console.error(error);
            sendJson(response, 500, { error: 'Erro interno do servidor.' });
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Alpha Pizzas: http://localhost:${PORT}`);
    });
}

main().catch(error => {
    console.error('Não foi possível iniciar o servidor:', error);
    process.exitCode = 1;
});
