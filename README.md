# Gestão de Fardamento e Inventário — Banda Marcial de Gueifães

Aplicação web para gerir o fardamento dos músicos da Banda Marcial de Gueifães: necessidades e tamanhos, entregas de fardamento novo, recolha e inspeção do fardamento antigo, inventário completo (peças individuais e quantidades), festas, campanhas e empréstimos a músicos convidados, com histórico imutável, auditoria e exportações em CSV, Excel e PDF.

> Interface, mensagens, relatórios e documentação em português de Portugal.

---

## Índice

1. [Funcionalidades](#funcionalidades)
2. [Arquitetura](#arquitetura)
3. [Requisitos](#requisitos)
4. [Estrutura de pastas](#estrutura-de-pastas)
5. [Configuração local](#configuração-local)
6. [Variáveis de ambiente e segredos](#variáveis-de-ambiente-e-segredos)
7. [Cloudflare D1](#cloudflare-d1)
8. [Cloudflare R2](#cloudflare-r2)
9. [Migrações](#migrações)
10. [Primeiro administrador](#criação-do-primeiro-administrador)
11. [Testes](#testes)
12. [Build](#build)
13. [Publicação na Cloudflare](#publicação-na-cloudflare)
14. [Domínio e HTTPS](#configuração-do-domínio-e-https)
15. [Cópias de segurança e recuperação](#cópias-de-segurança-e-recuperação)
16. [Atualizações](#procedimentos-de-atualização)
17. [Exportações](#formato-das-exportações)
18. [Segurança](#segurança)
19. [Resolução de problemas](#resolução-de-problemas-frequentes)

Documentação complementar: [`docs/modelo-dados.md`](docs/modelo-dados.md) (modelo de dados) e [`docs/regras-stock.md`](docs/regras-stock.md) (regras de stock, transações e decisões críticas).

---

## Funcionalidades

- **Contas e perfis**: Administrador, Responsável pelo fardamento e Consulta; permissões verificadas no servidor em todos os endpoints.
- **Pedido de fardamento por músico** num só ecrã: quantidade (obrigatória), tamanho (opcional) e peças antigas a devolver de cada artigo; **medidas** opcionais (altura, peito, cintura, anca, ombros, manga, entrepernas, pescoço, cabeça, sapato).
- **Eliminar e anular**: músicos sem histórico, artigos do pedido, tipos de artigo, tamanhos, localizações, festas sem empréstimos, campanhas e ocorrências podem ser eliminados; entregas, empréstimos, recolhas (antes da inspeção) e entradas de stock registadas por engano podem ser **anuladas** (o stock é reposto e fica registo). O que tem histórico de fardamento não se apaga — arquiva-se.
- **Mensagens**: telemóvel (opcional) de cada músico; botão «Lembrar devolução da farda» nas festas e empréstimos e «Enviar mensagem» na ficha do músico, com modelos editáveis. Abre o WhatsApp ou a app de SMS com o texto pronto (sem custos); cada envio fica registado. O envio totalmente automático exige um serviço de SMS pago (não configurado).
- **Eliminar peças do inventário** (administrador e responsável pelo fardamento): qualquer peça pode ser apagada definitivamente, individualmente (ficha da peça → «Eliminar peça») ou em seleção múltipla (Inventário → marcar as caixas → «Eliminar»), com motivo registado na auditoria. Se a peça estiver com um músico ou tiver histórico, a aplicação avisa antes; ao eliminar, a peça sai da posse do músico e das entregas/empréstimos onde aparecia (entregas que fiquem vazias são apagadas; nas recolhas fica o artigo, sem ligação à peça). Para peças estragadas ou perdidas que existiram, prefira o abate/extravio, que mantém o histórico.
- **Fardamento que o músico já tem**: na ficha do músico, regista as peças que já estão na sua posse (quantidade, tamanho opcional, estado, nome inscrito); cada peça recebe código/QR e fica atribuída ao músico, sem sair do stock; pode contar para o pedido.
- **Músicos**: fichas individuais (dados, necessidades e tamanhos, entregas, fardamento antigo devolvido, empréstimos, observações e fotografias, histórico); deteção de duplicados; músicos da banda e convidados.
- **Necessidades e encomendas**: quantidades por artigo/tamanho (várias camisas por músico), encomendado/recebido/distribuído/em falta; sapatos registados apenas como necessidade (sem aquisição nem stock).
- **Entrega guiada** de fardamento novo com seleção das peças concretas (código) ou lotes, atualização do stock e da ficha, resumo do que falta e folha de entrega em PDF com assinaturas.
- **Recolha guiada** do fardamento antigo: associação às peças atribuídas, criação de registo para peças antigas sem código, estado observado, fotografias, inspeção e decisão de destino (reintegrar, quarentena, reparação, reservar, abater, rejeitar). Uma peça recebida **nunca** fica disponível automaticamente.
- **Inventário peça a peça**: cada peça de fardamento tem código permanente (`CAS-00001`, `CAM-00042`…) e etiqueta QR; os casacos têm também a inscrição do nome. O modo «por quantidade» continua disponível para artigos futuros. Estados separados (disponível, reservado, atribuído, emprestado, pendente de inspeção, quarentena, reparação, abatido, extraviado, rejeitado).
- **Entrada de stock inicial** com revisão antes de confirmar e distinção entre quantidades contadas e estimadas; **receção de artigos novos**.
- **Contagens físicas** com propostas de ajuste, motivo obrigatório e confirmação de administrador.
- **Festas** da banda: vários empréstimos a músicos convidados por festa, devoluções parciais em momentos diferentes, danos, perdas, reconciliação e encerramento com pendências apenas com confirmação explícita.
- **Movimentos imutáveis** com estorno, **auditoria** completa, **alertas** calculados em tempo real, **painel de controlo**.
- **Exportações**: CSV (UTF-8 com BOM, `;`), XLSX verdadeiro com várias folhas e filtros, PDF (fichas, folhas de entrega/recolha, empréstimos, festas, inventário, pendências, etiquetas QR).
- **Fotografias** em R2 privado, com remoção de metadados EXIF, miniaturas e acesso controlado.
- **Assistente inicial** retomável.
- Interface adaptável a computador, tablet e telemóvel (câmara do telemóvel para fotografias).

## Arquitetura

```
 Navegador (React + TypeScript + Tailwind, SPA)
        │  HTTPS, cookie de sessão HttpOnly/Secure/SameSite=Strict, cabeçalho anti-CSRF
        ▼
 Cloudflare Worker "fardamento-bmg"  (um único Worker)
   ├─ /api/*  → Hono (REST): autenticação, permissões, validação Zod, regras de negócio, exportações
   └─ restante → Workers Static Assets (dist/client, fallback SPA, cabeçalhos em public/_headers)
        │
        ├─ D1 (binding DB)     → base de dados relacional, migrações versionadas, triggers de integridade
        └─ R2 (binding FILES)  → fotografias privadas (sem URL público)
```

**Decisão**: em vez de Cloudflare Pages + Worker separado, usa-se **um único Worker com Static Assets** (a abordagem atualmente recomendada pela Cloudflare). Vantagens: mesma origem para frontend e API (sem CORS, cookies `SameSite=Strict` e `__Host-`), um só deploy, uma só configuração (`wrangler.jsonc`).

Principais bibliotecas: `hono` (router), `zod` (validação), `pdf-lib` (PDF), `fflate` (ZIP do XLSX — o gerador XLSX é próprio, sem dependências pesadas), `qrcode-generator` (QR), `react`, `react-router-dom`, `@tanstack/react-query`, `tailwindcss`. Testes com `vitest` + `@cloudflare/vitest-plugin` (executam no runtime real dos Workers, com D1 e R2 locais).

Gestão do stock misto e integridade: ver [`docs/regras-stock.md`](docs/regras-stock.md). Em resumo, **os movimentos são a fonte de verdade**; o estado das peças e os saldos por quantidade são materializados por triggers SQL na mesma transação, que recusam stock negativo, estados incoerentes e alterações sem movimento.

## Requisitos

- Node.js ≥ 20 (testado com Node 22) e npm.
- Conta Cloudflare (plano gratuito é suficiente para começar; D1 e R2 incluídos com limites).
- Para publicar: `wrangler` autenticado (`npx wrangler login`) ou um API token com permissões *Workers Scripts*, *D1* e *R2* (edit).

## Estrutura de pastas

```
fardamento-bmg/
├── migrations/                 # Migrações SQL versionadas (D1)
│   ├── 0001_esquema_inicial.sql
│   └── 0002_dados_referencia.sql
├── shared/domain.ts            # Estados, etiquetas pt-PT, perfis e permissões (frontend + Worker)
├── worker/                     # API (Cloudflare Worker)
│   ├── index.ts                # Montagem da aplicação, cabeçalhos, erros, SPA
│   ├── env.ts                  # Tipos dos bindings
│   ├── auth/                   # Palavras-passe (PBKDF2), sessões, CSRF, permissões
│   ├── lib/                    # Núcleo (transações, idempotência, auditoria, validação), imagens
│   ├── services/stock.ts       # Movimentos de stock e verificação de consistência
│   ├── routes/                 # Endpoints REST por recurso
│   └── exports/                # CSV, XLSX, PDF, etiquetas, conjuntos de dados
├── src/                        # Frontend React
│   ├── api/client.ts           # Cliente HTTP
│   ├── components/             # UI, tabelas, formulários, fotografias, seletores
│   ├── lib/                    # Autenticação, hooks, formatação pt-PT
│   └── pages/                  # Páginas
├── public/                     # Logótipo, favicon, _headers (CSP e segurança), robots.txt
├── test/                       # Testes automatizados (Workers runtime)
├── scripts/                    # dev.mjs, backup-d1.mjs
├── docs/                       # Modelo de dados e regras de stock
├── wrangler.jsonc              # Configuração Cloudflare (dev + production)
├── vite.config.ts, vitest.config.ts, tsconfig*.json
└── package.json
```

## Configuração local

```bash
npm install
cp .dev.vars.example .dev.vars        # e altere SETUP_TOKEN
npm run db:migrate:local              # cria a base D1 local (.wrangler/)
npm run dev                           # API em :8787 + frontend em http://localhost:5173
```

Alternativa sem Vite (igual à produção): `npm run preview` → http://localhost:8787.

Em desenvolvimento, D1 e R2 são simulados localmente pelo Wrangler/Miniflare (pasta `.wrangler/`); nenhum dado local chega à produção.

## Variáveis de ambiente e segredos

| Nome | Tipo | Onde | Descrição |
|---|---|---|---|
| `ENVIRONMENT` | var | `wrangler.jsonc` | `development` / `production` (em produção ativa cookies `__Host-…; Secure` e HSTS) |
| `ALLOWED_ORIGINS` | var | `wrangler.jsonc` (env.production) | Origens adicionais autorizadas, separadas por vírgulas (a própria origem do Worker é sempre aceite). Normalmente vazio |
| `SETUP_TOKEN` | **segredo** | `wrangler secret put SETUP_TOKEN --env production` / `.dev.vars` | Código de inicialização (≥ 16 caracteres) exigido para criar o primeiro administrador. Pode ser removido depois |
| `DB` | binding D1 | `wrangler.jsonc` | Base de dados |
| `FILES` | binding R2 | `wrangler.jsonc` | Fotografias |

Nunca coloque segredos em `wrangler.jsonc` nem no repositório. `.dev.vars` está no `.gitignore`.

## Cloudflare D1

```bash
npx wrangler login
npx wrangler d1 create fardamento-bmg
```

Copie o `database_id` devolvido para `wrangler.jsonc` → `env.production.d1_databases[0].database_id` (substituindo `PREENCHER_COM_O_ID_DA_BASE_D1`).

## Cloudflare R2

```bash
npx wrangler r2 bucket create fardamento-bmg-anexos
```

O bucket fica **privado** (não ative acesso público nem domínio `r2.dev`). As fotografias só são servidas pela API, a utilizadores autenticados, com `Content-Security-Policy: sandbox` e `nosniff`.

## Migrações

```bash
npm run db:migrate:local     # desenvolvimento
npm run db:migrate:prod      # produção (pede confirmação)
npx wrangler d1 migrations list fardamento-bmg --remote --env production
```

Migrações incluídas: `0001` (esquema), `0002` (dados de referência), `0003` (eliminação de músicos sem histórico e medidas), `0004` (todos os artigos com código individual, apenas nos tipos ainda sem stock), `0005` (instrumento do músico), `0006` (telemóvel, lembretes de devolução e eliminação de peças), `0007` (registo do fardamento que os músicos já têm).

Regras: nunca editar uma migração já aplicada; cada alteração ao esquema é um novo ficheiro `migrations/000N_descricao.sql`. Antes de aplicar migrações em produção, faça uma cópia de segurança (ver abaixo). As migrações incluídas não são destrutivas.

## Criação do primeiro administrador

1. Defina o segredo: `npx wrangler secret put SETUP_TOKEN --env production` (introduza um valor longo e aleatório, ex.: `openssl rand -base64 32`).
2. Abra a aplicação; enquanto não existir nenhum utilizador, é apresentada a página **Configuração inicial**.
3. Indique o código, nome, email e palavra-passe (≥ 10 caracteres, letras + números/símbolos).
4. O servidor só cria o administrador se a tabela de utilizadores estiver vazia (verificação atómica). Depois disso o endpoint recusa novos pedidos.
5. Opcional: remova o segredo (`npx wrangler secret delete SETUP_TOKEN --env production`).
6. Siga o **Assistente inicial** (tipos de artigo e tamanhos → estados → localizações → stock inicial → músicos e necessidades). Pode interrompê-lo e retomá-lo.

**Administrador sem acesso** (palavra-passe esquecida): defina/altere o segredo `SETUP_TOKEN` no painel Cloudflare (Workers & Pages → fardamento-bmg → Settings → Variables and Secrets) e abra `/recuperar-acesso` (ligação «Sou administrador e perdi o acesso» no ecrã de entrada). Indique o código, o email do administrador e a nova palavra-passe. Tentativas limitadas e auditadas.

Não existe registo público; as restantes contas são criadas por um administrador (palavra-passe provisória, com aviso para alteração). Recuperação de palavra-passe: o administrador gera em **Utilizadores** uma ligação de utilização única válida 24 h (não há envio de email, por não existir serviço configurado).

## Testes

```bash
npm test            # 56 testes de integração no runtime Workers (D1/R2 locais)
npm run typecheck   # TypeScript (frontend e Worker)
```

Cobertura: autenticação, sessões, limitação de tentativas, CSRF, permissões por perfil; músicos, duplicados, várias camisas, sapatos sem aquisição; stock inicial, códigos únicos, quantidades, stock negativo, quarentena/reparação/abate, histórico, imutabilidade, estorno, contagens, consistência; entregas (limites de stock e de necessidade, atomicidade), recolhas e inspeção; campanhas, vários empréstimos, devoluções parciais, excesso, danos, perdas, encerramento com pendências; idempotência (duplo clique) e concorrência (dois empréstimos simultâneos da mesma peça); uploads (tipos, EXIF, acesso); CSV/XLSX/PDF válidos, filtros e permissões.

## Build

```bash
npm run build       # typecheck + vite build → dist/client
```

## Publicação na Cloudflare

Passos (uma vez):

```bash
npm install
npx wrangler login                                   # ou CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 create fardamento-bmg                # copiar database_id para wrangler.jsonc (env.production)
npx wrangler r2 bucket create fardamento-bmg-anexos
npm test
npm run db:migrate:prod                              # aplica 0001 e 0002 à base de produção
npx wrangler secret put SETUP_TOKEN --env production
npm run deploy                                       # build + wrangler deploy --env production
```

O Wrangler apresenta o endereço `https://fardamento-bmg.<subdominio>.workers.dev`. Verificações após a publicação:

```bash
curl https://<endereço>/api/health          # {"ok":true,"environment":"production"}
curl https://<endereço>/api/setup/status    # {"needsAdmin":true,...} antes de criar o administrador
```

Depois: criar o administrador, iniciar sessão, registar uma localização e uma entrada de stock de teste numa contagem (ou numa instalação de testes separada) e confirmar o movimento em **Movimentos**.

> Recomenda-se uma instalação de testes separada (outra base D1/bucket R2 e outro nome de Worker, ex.: `env.staging`) para experimentar sem misturar dados de teste com dados reais.

## Configuração do domínio e HTTPS

1. O domínio tem de estar gerido pela Cloudflare (DNS na Cloudflare).
2. Em `wrangler.jsonc`, dentro de `env.production`, acrescente:
   ```jsonc
   "routes": [{ "pattern": "fardamento.exemplo.pt", "custom_domain": true }]
   ```
   e volte a publicar (`npm run deploy`). A Cloudflare cria o registo DNS e o certificado TLS automaticamente.
   O domínio tem de estar na **mesma conta** Cloudflare; caso contrário o deploy falha com «Can't infer zone from route» (código 10082) e, se `workers_dev` não estiver a `true`, a aplicação fica sem endereço.
3. HTTPS é obrigatório: o cookie de sessão de produção usa o prefixo `__Host-` e `Secure`, e a aplicação envia HSTS.
4. Opcional: desative o endereço `workers.dev` (mude `"workers_dev"` para `false` em `env.production`) depois de o domínio funcionar.
5. Opcional e recomendado: proteja adicionalmente o acesso com Cloudflare Access (Zero Trust) para os emails dos utilizadores.

## Cópias de segurança e recuperação

**D1**
- *Time Travel* (incluído no D1): permite restaurar a base para qualquer minuto dos últimos 30 dias (plano pago) ou 7 dias (plano gratuito):
  ```bash
  npx wrangler d1 time-travel info fardamento-bmg --env production
  npx wrangler d1 time-travel restore fardamento-bmg --env production --timestamp=2026-10-16T10:00:00Z
  ```
  O restauro substitui o estado atual — use-o apenas após confirmação explícita.
- *Exportação manual* (cópia fora da Cloudflare), recomendada semanalmente e antes de cada migração:
  ```bash
  npm run db:backup:prod      # cria backups/fardamento-bmg-<data>.sql
  ```
  Guarde os ficheiros num local seguro (contêm dados pessoais). Restauro numa base nova: `npx wrangler d1 execute <nova-base> --remote --file=backups/<ficheiro>.sql`.
- Nenhuma cópia automática externa foi configurada por esta instalação: a única proteção automática é o Time Travel do D1. Para automatizar exportações, agende `npm run db:backup:prod` (ex.: GitHub Actions com segredo `CLOUDFLARE_API_TOKEN`) — ação que fica do lado da banda.

**R2**
- O R2 não tem versões automáticas. Para cópia das fotografias: `npx wrangler r2 object get` por objeto, ou sincronização com `rclone` (endpoint S3 do R2 com chaves de API R2 de leitura). As chaves dos objetos estão na tabela `attachments` (`r2_key`).
- Remover uma fotografia na aplicação apaga o objeto do R2 (o registo fica marcado como removido e auditado).

## Procedimentos de atualização

1. `git pull` (ou obtenha a nova versão) e `npm install`.
2. `npm test` e `npm run build`.
3. Cópia de segurança: `npm run db:backup:prod`.
4. Se houver migrações novas: `npm run db:migrate:prod`.
5. `npm run deploy`.
6. Verifique `/api/health`, inicie sessão e confirme o painel.
Para reverter código: `npx wrangler rollback --env production` (não reverte a base de dados).

## Formato das exportações

- **CSV**: UTF-8 com BOM, separador `;` (a vírgula é o separador decimal em Portugal), todos os campos entre aspas, linhas CRLF, datas `dd/mm/aaaa`, valores monetários `1.234,56`. Abre diretamente no Excel em português. Proteção contra *CSV injection*: texto que comece por `=`, `+`, `-`, `@`, tabulação ou CR é prefixado com `'`.
- **XLSX**: ficheiro Office Open XML verdadeiro; título, data de emissão e filtros nas primeiras linhas, cabeçalho formatado, painel fixo, filtro automático, larguras de coluna; o «livro completo» tem uma folha por área. Texto gravado como texto (nunca como fórmula).
- **PDF**: A4, logótipo e identificação da banda, título, data de emissão, filtros aplicados, paginação e campos de assinatura (entrega, receção, inspeção) quando aplicável.
- Todas as exportações exigem sessão e permissão `export`, e ficam registadas na auditoria.

## Segurança

- Palavras-passe com PBKDF2-SHA256 (100 000 iterações, sal aleatório); nunca guardadas nem registadas em texto simples.
- Sessões: token aleatório de 256 bits; na base apenas o SHA-256; cookie `HttpOnly`, `SameSite=Strict`, `Secure` + prefixo `__Host-` em produção; expiração por inatividade e absoluta; revogação individual, das restantes sessões e por administrador; revogação automática ao mudar palavra-passe, perfil ou desativar conta.
- CSRF: cookie `SameSite=Strict` + cabeçalho obrigatório `X-BMG-CSRF` (não enviável entre origens sem CORS, que não está ativo) + validação do cabeçalho `Origin`.
- Limitação de tentativas de autenticação (5 falhas/15 min por email, 30 por IP — guardados em hash).
- Autorização por perfil verificada no servidor em cada endpoint.
- SQL sempre parametrizado; ordenações por lista branca; validação Zod de todos os dados.
- Uploads: apenas JPEG/PNG/WebP verificados pelos *magic bytes*, limites de tamanho e dimensões, nomes gerados pela aplicação, EXIF/XMP removidos no servidor (e reprocessamento no navegador), servidos com `nosniff` e CSP `sandbox`.
- Cabeçalhos: CSP restritiva, `X-Frame-Options: DENY`, `Referrer-Policy`, HSTS, `noindex`.
- Erros internos nunca expostos ao cliente; registos sem credenciais.

## Resolução de problemas frequentes

| Sintoma | Causa provável / solução |
|---|---|
| «O segredo SETUP_TOKEN não está configurado» | `wrangler secret put SETUP_TOKEN --env production` (≥ 16 caracteres) ou `.dev.vars` em local |
| `no such table: users` | Migrações não aplicadas: `npm run db:migrate:local` ou `npm run db:migrate:prod` |
| `Couldn't find a D1 DB with the name or binding` | `database_id` em falta/errado em `wrangler.jsonc` (env.production) |
| «Pedido recusado por motivos de segurança (CSRF)» | Pedido feito fora da aplicação ou de outra origem; acrescente a origem a `ALLOWED_ORIGINS` só se for legítima |
| Sessão termina ao usar `http://` em produção | Os cookies `__Host-` exigem HTTPS |
| «Stock insuficiente» / «A peça já não se encontra no estado esperado» | Proteções de integridade: outra operação movimentou o artigo; atualize a página |
| «Demasiadas tentativas falhadas» | Aguarde 15 minutos ou peça ao administrador uma ligação de redefinição |
| Fotografia recusada | Formato não suportado (use JPEG/PNG/WebP) ou acima do limite configurado em Configurações → Geral |
| CSV com acentos estranhos | Abra pelo Excel (o BOM indica UTF-8); em LibreOffice escolha UTF-8 e separador `;` |
| Inconsistência suspeita | Inventário → «Verificar consistência» (administrador) |
