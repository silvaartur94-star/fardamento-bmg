# Regras de stock e decisões críticas

## 1. Inventário misto: peças individuais e quantidades

Cada tipo de artigo tem **um único** modo de gestão:

| Modo | Exemplo (configuração inicial) | Registo | Identificação |
|---|---|---|---|
| `individual` | Casaco | Uma linha em `garments` por peça | Código permanente `CAS-00001`, inscrição do nome, etiqueta QR |
| `quantidade` | Calças, Camisa, Cinto, Boné, Gravata | Saldos em `stock_balances` | Tipo + tamanho + conservação + localização + estado |
| sem stock | Sapatos | Apenas necessidades | — |

Uma unidade física nunca existe nos dois registos: o trigger `garments_before_insert` só aceita peças de tipos individuais, o trigger `movements_quantity_check` só aceita movimentos por quantidade de tipos por quantidade, e o modo de um tipo fica bloqueado (`item_types_mode_guard`) logo que exista stock ou movimentos.

## 2. Fonte única de verdade

**Os movimentos (`stock_movements`) são a fonte de verdade.** O estado de cada peça (`garments.status`) e os saldos (`stock_balances`) são valores materializados, alterados **exclusivamente** pelos triggers que correm na mesma transação em que o movimento é inserido:

- `movements_garment_check` — a peça tem de estar exatamente no estado de origem indicado (`ESTADO_PECA_ALTERADO` caso contrário). Isto impede entregar/emprestar a mesma peça a dois destinos, mesmo em pedidos simultâneos.
- `movements_garment_apply` — aplica estado, conservação, localização e detentor.
- `movements_quantity_check` — o lote de origem tem de ter quantidade suficiente (`STOCK_INSUFICIENTE`).
- `movements_quantity_apply` — retira da origem e soma ao destino; `CHECK (quantity >= 0)` como segunda barreira.
- `garments_status_guard` — qualquer alteração de estado de uma peça que não corresponda ao último movimento é recusada (`ESTADO_SEM_MOVIMENTO`).
- `stock_movements_no_update/no_delete` — movimentos imutáveis; corrige-se com **estorno** (movimento inverso, com motivo, ligado ao original) ou **ajuste**.

O administrador dispõe de **Inventário → Verificar consistência**, que recalcula todos os saldos a partir dos movimentos e compara estados e empréstimos.

## 3. Estados

Disponível · Reservado · Atribuído a músico · Emprestado · Pendente de inspeção · Em quarentena · Em reparação · Abatido · Extraviado · Rejeitado.

- **Stock disponível** = apenas o estado *Disponível*. O painel e os relatórios mostram cada estado em separado; nunca somam tudo como disponível.
- **Stock físico existente** = todos exceto Abatido, Extraviado e Rejeitado.

## 4. Transações, concorrência e idempotência

- Cada operação (entrega, recolha, decisão de inspeção, empréstimo, devolução, entrada, ajuste, contagem) é executada num único `db.batch()` do D1, que é **atómico**: se qualquer instrução falhar (trigger, CHECK, chave), nada é gravado.
- O D1 serializa as escritas; combinado com a verificação do estado de origem nos triggers, dois pedidos simultâneos para a mesma peça resultam num sucesso e numa recusa (testado).
- **Idempotência**: o frontend envia `Idempotency-Key` em todas as operações críticas e reutiliza-a até ao sucesso. A chave é inserida na mesma transação; um duplo clique ou um pedido repetido devolve a resposta original sem repetir movimentos. O botão fica também desativado durante o envio.
- Devoluções acima do emprestado: `CHECK (returned_quantity + lost_quantity <= quantity)`.
- Entregas acima da necessidade: trigger `delivery_lines_request_guard`.

## 5. Fluxos e movimentos gerados

| Operação | Movimento | De → Para |
|---|---|---|
| Stock inicial / receção de novos | `stock_inicial` / `rececao_nova` | — → Disponível (ou outro estado escolhido) |
| Entrega a músico | `entrega_musico` | Disponível → Atribuído (detentor = músico) |
| Anulação de linha de entrega | `anulacao_entrega` | Atribuído → Disponível |
| Recolha de fardamento antigo | `recolha_musico` | Atribuído ou — → **Pendente de inspeção** (nunca disponível) |
| Decisão de inspeção | `aprovacao_entrada`, `quarentena`, `envio_reparacao`, `reserva`, `abate`, `rejeicao` | Pendente de inspeção → destino |
| Empréstimo | `emprestimo` | Disponível → Emprestado |
| Devolução de empréstimo | `devolucao_emprestimo` | Emprestado → Disponível; se danificada/mau estado → Pendente de inspeção, Quarentena ou Reparação |
| Perda em empréstimo | `extravio` | Emprestado → Extraviado (+ ocorrência) |
| Movimentos de inventário | `transferencia`, `envio_reparacao`, `regresso_reparacao`, `quarentena`, `reserva`, `libertacao_reserva`, `abate`, `extravio`, `ajuste` | Conforme a transição permitida |
| Contagem física confirmada | `ajuste` (quantidades) / `extravio` (peças não encontradas) | Diferença em relação ao saldo **atual** |
| Estorno | `estorno` | Inverso do original (apenas movimentos de inventário sem documento associado) |

Regras adicionais:
- Peças em estado *Mau* ou *Inutilizável* não podem ser reintegradas diretamente como disponíveis.
- Abate, extravio e rejeição exigem motivo e permissão `inventory.writeoff`.
- Ajustes manuais e confirmação de contagens: apenas administradores, com motivo obrigatório.

## 6. Necessidades e encomendas

- Quantidade pretendida, encomendada e recebida são registadas na necessidade; **a quantidade distribuída é calculada** a partir das linhas de entrega ligadas (evita contabilização dupla).
- Sapatos (tipo com aquisição e stock desativados): estados *Por avaliar / Necessidade confirmada / Resolvida / Cancelada*; não podem ser encomendados nem entram em stock; o tamanho original (ex.: «42,5») é preservado em `size_text`.
- «Peças antigas a devolver» por necessidade permite saber o que falta devolver; o devolvido calcula-se pelas recolhas.

## 7. Stock inicial

Entrada guiada com revisão antes de confirmar; cada linha indica se a quantidade foi **contada** ou **estimada**. O estado de verificação mantém-se visível até uma contagem física o confirmar.
