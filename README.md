# Alpha Pizzas: site e backend

## Requisitos

- Node.js 18 ou superior
- Nenhuma dependencia externa

## Executar localmente no Windows PowerShell

1. Copie `.env.example` para `.env` e defina `ADMIN_PASSWORD` com uma senha forte (12 caracteres ou mais).
2. Execute `npm start` na pasta do projeto.
3. Abra `http://localhost:4173` para o site ou `http://localhost:4173/admin.html` para o painel.

Na primeira inicializacao, se `ADMIN_PASSWORD` nao estiver definida e ainda nao existir uma senha salva, o servidor gera uma senha aleatoria e a mostra no terminal. Guarde-a e altere-a pelo painel.

Depois do primeiro boot, o hash salvo em `data/admin-password.json` tem prioridade sobre o `.env`: trocar a senha pelo painel nao afeta o `.env`, e vice-versa. O `.env` define a senha de instalacoes novas (outra maquina, novo disco).

## Aviso de saida para entrega pelo WhatsApp

O checkout coleta o numero de WhatsApp do cliente e a autorizacao para contato. Quando a loja muda o status para "Saiu para Entrega", o painel abre a conversa com uma mensagem pronta. A loja deve revisar e tocar em Enviar no WhatsApp; nenhuma API da Meta ou credencial e necessaria. Pedidos antigos sem telefone cadastrado nao conseguem abrir uma conversa.

## Persistencia

O cardapio e o hash da senha ficam em `data/`; imagens enviadas pelo painel ficam em `uploads/`. Faca backup dessas duas pastas. Em hospedagem, configure um disco persistente para elas e defina `ADMIN_PASSWORD` nas variaveis de ambiente. Use HTTPS em producao.

O painel usa sessao de servidor por cookie HttpOnly e SameSite Strict. A senha e armazenada com hash scrypt. O backend valida os produtos e aceita uploads PNG, JPEG e WebP de ate 5 MB.

### Persistencia via GitHub (hospedagem com disco efemero)

Hospedagens com disco efemero (Render free, Heroku free) apagam a cada novo deploy tudo que esta fora do repositorio: pedidos recebidos, cardapio editado pelo painel, bairros, chave Pix e as fotos enviadas pelo painel.

Para resolver isso, o servidor espelha esses arquivos em uma branch de dados do proprio repositorio (padrao `alpha-data`), que nao e a branch de deploy. Assim:

- cada pedido, edicao de cardapio, foto ou mudanca de bairro vira um commit na branch de dados (sem disparar novo deploy);
- no boot, o servidor restaura os arquivos a partir dessa branch;
- se voce alterou um arquivo direto no repositorio depois do ultimo sync, a versao do repositorio prevalece (ela e mais nova).

Para ativar, defina no ambiente do servidor:

```
GITHUB_TOKEN = <token fine-grained com permissao Contents: read/write>
GITHUB_REPO = LHenrique2/Alfa_pizzas
GITHUB_DATA_BRANCH = alpha-data      # opcional
GITHUB_DEPLOY_BRANCH = main          # opcional: detectado automaticamente
```

Sem `GITHUB_TOKEN` e `GITHUB_REPO` o recurso fica desligado e nada muda. O hash da senha (`data/admin-password.json`) nunca e versionado; em hospedagem, defina `ADMIN_PASSWORD` no ambiente para a senha do painel ser sempre a mesma.

`data/orders.json` tambem nao e versionado: e dado de execucao (pedidos recebidos), nao configuracao. Se ele estivesse no repositorio, cada push dele "envelheceria" o backup e os pedidos seriam sobrescritos no deploy seguinte.

Quem decide a versao que vale e a data da ultima alteracao:

- alteracao feita no painel (admin) -> espelhada na branch de dados (mais nova);
- alteracao feita direto no repositorio e enviada -> mantida e propagada para a branch de dados;
- arquivo que nao existe no repositorio (como `data/orders.json`) -> a versao da branch de dados sempre vence, entao nenhum pedido se perde em um deploy.

O estado do espelhamento aparece em `GET /api/health` no campo `dataSync`.

## Paginas

- `index.html` e a pagina do cliente. E a unica fonte da verdade do front-end.
- `admin.html` e o painel administrativo.
- `alpha_pizzas_site.html` e apenas um redirect legado para `index.html` (o servidor responde 301). Nao edite o cardapio nem o checkout em dois lugares: o arquivo antigo quebrou o checkout uma vez e o problema so apareceu em producao.

## Busca de produtos no cardapio 3D

A roleta tem uma caixa de busca (`#menuSearch`) que filtra os itens por nome, descricao e badge, junto com o filtro de categoria. Detalhes:

- ignora acentos e maiusculas: "mucarela" acha "Mucarela", "guarana" acha "Guaraná";
- varias palavras: primeiro exige todas ("calabresa tradicional"); se ninguem tem todas, mostra quem tem pelo menos uma;
- "adicionais" (bordas e extras) nao entram na roleta, como antes;
- o contador mostra quantos produtos foram encontrados e o botao ✕ limpa o campo;
- sem resultado, aparece um aviso no lugar da roleta;
- digitar na busca para o giro automatico.

O cache do service worker foi para `alpha-pizzas-v22` por causa dessa mudanca.

## Precos e segurança dos pedidos

O navegador manda apenas o `id` do produto, a quantidade e o tamanho da pizza. O servidor recalcula o preco e o titulo a partir de `data/menu.json`, aplica a taxa do bairro e rejeita produtos que nao existem mais ou que estao esgotados. Nao confie em preco enviado pelo cliente.

A senha do painel nunca tem valor padrao: se `ADMIN_PASSWORD` nao existir, o servidor gera uma senha aleatoria e mostra no terminal. Os pedidos sao gravados em fila, entao dois pedidos simultaneos nao se perdem.

## Mudancas no service worker

Ao alterar `index.html`, `logo.png`, `hero-bg.jpg` ou os icones, aumente `CACHE_NAME` em `service-worker.js` (por exemplo `alpha-pizzas-v22` para `v23`). Sem isso, usuarios com o app instalado continuam vendo a versao antiga do cache.
