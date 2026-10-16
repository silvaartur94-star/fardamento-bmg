# Modelo de dados

Base de dados: **Cloudflare D1** (SQLite). Esquema em `migrations/0001_esquema_inicial.sql`; dados de referência em `migrations/0002_dados_referencia.sql`.
Todas as datas/horas são guardadas em UTC (ISO 8601); as datas simples em `AAAA-MM-DD`. Os identificadores são UUID gerados pela aplicação.

## Visão geral

```
users ─┬─ sessions / password_reset_tokens / idempotency_keys
       └─ (autor de) movimentos, auditoria, entregas, recolhas, empréstimos…

item_types ─┬─ item_sizes (escala própria por tipo)
            ├─ garments (peças individuais, modo "individual")
            └─ stock_balances (saldos por quantidade, modo "quantidade")

stock_movements  ← registo imutável; materializa garments.status e stock_balances por TRIGGERS

musicians ─┬─ musician_item_requests (necessidades)
           ├─ musician_deliveries ── musician_delivery_lines (→ garment | lote, → request)
           ├─ garment_returns ── garment_return_lines (inspeção e destino)
           └─ loans ── loan_lines ── loan_returns

festival_campaigns ── events ── loans
attachments (R2)   incidents   inventory_counts ── inventory_count_lines   audit_logs   settings   locations
```

## Tabelas

| Tabela | Finalidade | Notas de integridade |
|---|---|---|
| `users` | Contas (nome, email único, hash PBKDF2, perfil `admin`/`gestor`/`consulta`, ativo) | Nunca apagadas; desativadas |
| `sessions` | Sessões; o ID é o SHA-256 do token do cookie | Expiração por inatividade (12 h) e absoluta (7 dias); revogáveis |
| `password_reset_tokens` | Ligações de redefinição (hash) | Utilização única, 24 h |
| `login_attempts` | Limitação de tentativas (chaves em hash) | Limpeza automática após 24 h |
| `idempotency_keys` | Respostas de operações críticas por (utilizador, chave) | Inserida na mesma transação da operação |
| `settings` | Configurações (JSON) | Lista branca de chaves |
| `locations` | Localizações físicas | Desativáveis |
| `item_types` | Tipos de artigo: modo (`individual`/`quantidade`), tem tamanho, inscrição, entra em aquisição, gerido em stock, prefixo de código, stock mínimo | Modo de gestão bloqueado quando existe stock/movimentos (trigger `item_types_mode_guard`) |
| `item_sizes` | Escala de tamanhos por tipo (alfanumérico ou numérico) | Único por (tipo, etiqueta); tamanhos usados não se renomeiam |
| `musicians` | Músicos da banda (`banda`) e convidados (`convidado`); `name_key` normalizado para deteção de duplicados | Código interno único quando preenchido; não podem ser apagados |
| `musician_item_requests` | Necessidades: quantidade pretendida, encomendada, recebida, peças antigas a devolver (`return_expected`), tamanho da lista e texto original (`size_text`) | A quantidade **entregue não é guardada**: calcula-se pelas linhas de entrega (vista `v_request_progress`) |
| `garments` | Peças individuais com código permanente (`CAS-00001`), inscrição, conservação, estado, origem, verificação (contado/estimado), localização, detentor | Código atribuído por trigger a partir de `code_sequences` (nunca reutilizado); estado só muda por movimento; não podem ser apagadas |
| `stock_balances` | Saldos agregados por `tipo|tamanho|conservação|localização|estado` | `CHECK (quantity >= 0)`; atualizados apenas por triggers dos movimentos |
| `stock_movements` | Movimentos: tipo, origem→destino (estado, conservação, localização), quantidade, músico, referência à operação, motivo, utilizador | Imutáveis (UPDATE/DELETE bloqueados); estorno via `reverses_movement_id` (único) |
| `musician_deliveries` / `_lines` | Entregas e respetivas peças/lotes; ligação opcional à necessidade | Trigger impede entregar mais do que a necessidade; `returned_quantity <= quantity` |
| `garment_returns` / `_lines` | Recolhas de fardamento antigo, inspeção (estado inspecionado, resultado, destino proposto e aprovado, responsáveis e datas) | Decisão de destino definitiva (trigger) |
| `festival_campaigns`, `events` | Campanhas e festas (festa pode não ter campanha) | Encerramento com pendências exige confirmação e notas |
| `loans`, `loan_lines`, `loan_returns` | Empréstimos por festa e músico; devoluções parciais e perdas | `returned + lost <= quantity` (CHECK) |
| `incidents` | Ocorrências (dano, perda, furto, outro) | Associadas a peça/músico/empréstimo/festa/recolha |
| `inventory_counts` / `_lines` | Contagens físicas com instantâneo do esperado e contado | Ajustes só na confirmação, com motivo |
| `attachments` | Metadados de fotografias no R2 privado | Remoção lógica + eliminação do objeto |
| `audit_logs` | Auditoria (utilizador, ação, entidade, resumo JSON, ID do pedido) | Imutável; campos sensíveis removidos |

## Vistas

- `v_request_progress` — necessidades com `quantity_delivered` calculada.
- `v_loan_lines` — linhas de empréstimo com `pending_quantity`.
- `v_musician_returns` — quantidade de peças antigas devolvidas por músico e tipo.

## Regras de eliminação e arquivo

- Músicos, peças e movimentos **não podem ser apagados** (triggers). Músicos passam a `inativo`/`arquivado`; peças são abatidas; movimentos estornados.
- Utilizadores, tipos de artigo, tamanhos e localizações são desativados.
- Fotografias: remoção lógica (`deleted_at`) e eliminação do ficheiro no R2, ficando registada na auditoria.
