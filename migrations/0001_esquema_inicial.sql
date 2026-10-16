-- =====================================================================
-- Banda Marcial de Gueifães — Gestão de Fardamento e Inventário
-- Migração 0001: esquema inicial
--
-- Princípios:
--  * Os movimentos de stock (stock_movements) são o registo de verdade.
--    O estado das peças individuais (garments.status) e os saldos por
--    quantidade (stock_balances) são materializados EXCLUSIVAMENTE por
--    triggers executados na mesma transação em que o movimento é inserido.
--  * Movimentos e auditoria são imutáveis (triggers impedem UPDATE/DELETE).
--  * Todas as datas/horas são guardadas em UTC, formato ISO 8601.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilizadores, sessões e autenticação
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'gestor', 'consulta')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  password_changed_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX users_email_uq ON users (email COLLATE NOCASE);

-- O ID da sessão é o hash SHA-256 do token entregue no cookie; o token
-- em claro nunca é guardado.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id, revoked_at);

-- Tokens de redefinição de palavra-passe (apenas hash SHA-256).
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);

-- Tentativas de autenticação para limitação (chaves já em hash).
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  attempted_at TEXT NOT NULL
);
CREATE INDEX login_attempts_key_idx ON login_attempts (key, attempted_at);

-- Chaves de idempotência das operações críticas.
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users (id),
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Configurações gerais (chave/valor JSON).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES users (id)
);

-- ---------------------------------------------------------------------
-- Listas de referência
-- ---------------------------------------------------------------------
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX locations_name_uq ON locations (name COLLATE NOCASE);

CREATE TABLE item_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  category TEXT NOT NULL,
  description TEXT,
  code_prefix TEXT NOT NULL CHECK (length(code_prefix) BETWEEN 2 AND 6 AND code_prefix = upper(code_prefix)),
  has_size INTEGER NOT NULL DEFAULT 1 CHECK (has_size IN (0, 1)),
  size_kind TEXT NOT NULL DEFAULT 'alfanumerico' CHECK (size_kind IN ('alfanumerico', 'numerico', 'livre')),
  allows_inscription INTEGER NOT NULL DEFAULT 0 CHECK (allows_inscription IN (0, 1)),
  tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('individual', 'quantidade')),
  -- 0 = apenas registo de necessidade (ex.: sapatos), não entra em aquisição nem stock.
  procurement_enabled INTEGER NOT NULL DEFAULT 1 CHECK (procurement_enabled IN (0, 1)),
  stock_enabled INTEGER NOT NULL DEFAULT 1 CHECK (stock_enabled IN (0, 1)),
  min_available INTEGER CHECK (min_available IS NULL OR min_available >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX item_types_name_uq ON item_types (name COLLATE NOCASE);
CREATE UNIQUE INDEX item_types_prefix_uq ON item_types (code_prefix);

CREATE TABLE item_sizes (
  id TEXT PRIMARY KEY,
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX item_sizes_uq ON item_sizes (item_type_id, label COLLATE NOCASE);

-- ---------------------------------------------------------------------
-- Músicos (da banda e convidados externos)
-- ---------------------------------------------------------------------
CREATE TABLE musicians (
  id TEXT PRIMARY KEY,
  internal_code TEXT,
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  -- Nome normalizado (minúsculas, sem acentos, espaços simples) para deteção de duplicados.
  name_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('banda', 'convidado')),
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'arquivado')),
  contact TEXT,
  origin_band TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES users (id)
);
CREATE UNIQUE INDEX musicians_code_uq ON musicians (internal_code COLLATE NOCASE) WHERE internal_code IS NOT NULL;
CREATE INDEX musicians_name_key_idx ON musicians (name_key);
CREATE INDEX musicians_kind_idx ON musicians (kind, status);

-- ---------------------------------------------------------------------
-- Necessidades de fardamento
-- A quantidade entregue NÃO é guardada aqui: é calculada a partir das
-- linhas de entrega (fonte única), evitando contabilização dupla.
-- ---------------------------------------------------------------------
CREATE TABLE musician_item_requests (
  id TEXT PRIMARY KEY,
  musician_id TEXT NOT NULL REFERENCES musicians (id),
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  size_id TEXT REFERENCES item_sizes (id),
  -- Valor do tamanho tal como foi indicado (preservado, ex.: calçado "42,5").
  size_text TEXT,
  quantity_requested INTEGER NOT NULL CHECK (quantity_requested > 0),
  quantity_ordered INTEGER NOT NULL DEFAULT 0 CHECK (quantity_ordered >= 0),
  quantity_received INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  -- Quantidade de peças antigas deste tipo que o músico deve devolver (substituídas).
  -- A quantidade já devolvida é calculada a partir das linhas de recolha.
  return_expected INTEGER NOT NULL DEFAULT 0 CHECK (return_expected >= 0),
  -- Artigos de aquisição: 'ativa' | 'cancelada' (o progresso é calculado).
  -- Artigos sem aquisição (sapatos): 'por_avaliar' | 'confirmada' | 'resolvida' | 'cancelada'.
  status TEXT NOT NULL CHECK (status IN ('ativa', 'cancelada', 'por_avaliar', 'confirmada', 'resolvida')),
  notes TEXT,
  requested_at TEXT NOT NULL,
  ordered_at TEXT,
  received_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES users (id)
);
CREATE INDEX requests_musician_idx ON musician_item_requests (musician_id);
CREATE INDEX requests_type_idx ON musician_item_requests (item_type_id, size_id, status);

-- ---------------------------------------------------------------------
-- Inventário: peças individuais
-- ---------------------------------------------------------------------
CREATE TABLE code_sequences (
  name TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL
);
INSERT INTO code_sequences (name, last_value) VALUES ('garment', 0);

CREATE TABLE garments (
  id TEXT PRIMARY KEY,
  -- Número sequencial global, atribuído por trigger, nunca reutilizado.
  serial INTEGER UNIQUE,
  code TEXT UNIQUE,
  legacy_code TEXT,
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  size_id TEXT REFERENCES item_sizes (id),
  inscription TEXT,
  condition TEXT NOT NULL CHECK (condition IN ('novo', 'bom', 'razoavel', 'mau', 'inutilizavel')),
  -- NULL apenas antes do primeiro movimento (dentro da mesma transação).
  status TEXT CHECK (status IS NULL OR status IN (
    'disponivel', 'reservado', 'atribuido', 'emprestado', 'pendente_inspecao',
    'quarentena', 'reparacao', 'abatido', 'extraviado', 'rejeitado')),
  origin TEXT NOT NULL CHECK (origin IN (
    'stock_inicial', 'devolucao_musico', 'aquisicao_nova', 'devolucao_emprestimo', 'doacao', 'outra')),
  origin_notes TEXT,
  verification TEXT NOT NULL DEFAULT 'contado' CHECK (verification IN ('contado', 'estimado', 'nao_verificado')),
  last_counted_at TEXT,
  entry_date TEXT NOT NULL,
  cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  location_id TEXT REFERENCES locations (id),
  holder_musician_id TEXT REFERENCES musicians (id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES users (id)
);
CREATE INDEX garments_type_idx ON garments (item_type_id, size_id, status);
CREATE INDEX garments_status_idx ON garments (status);
CREATE INDEX garments_holder_idx ON garments (holder_musician_id);
CREATE INDEX garments_location_idx ON garments (location_id);
CREATE INDEX garments_legacy_idx ON garments (legacy_code);

-- ---------------------------------------------------------------------
-- Inventário: saldos por quantidade (materializados a partir dos movimentos)
-- bucket_key = tipo|tamanho|condição|localização|estado
-- ---------------------------------------------------------------------
CREATE TABLE stock_balances (
  bucket_key TEXT PRIMARY KEY,
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  size_id TEXT REFERENCES item_sizes (id),
  condition TEXT NOT NULL CHECK (condition IN ('novo', 'bom', 'razoavel', 'mau', 'inutilizavel')),
  location_id TEXT REFERENCES locations (id),
  status TEXT NOT NULL CHECK (status IN (
    'disponivel', 'reservado', 'atribuido', 'emprestado', 'pendente_inspecao',
    'quarentena', 'reparacao', 'abatido', 'extraviado', 'rejeitado')),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  verification TEXT NOT NULL DEFAULT 'contado' CHECK (verification IN ('contado', 'estimado', 'nao_verificado')),
  last_counted_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX stock_balances_type_idx ON stock_balances (item_type_id, size_id, status);
CREATE INDEX stock_balances_status_idx ON stock_balances (status);

-- ---------------------------------------------------------------------
-- Movimentos de stock (registo imutável)
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'stock_inicial', 'rececao_nova', 'recolha_musico', 'aprovacao_entrada', 'entrega_musico',
    'anulacao_entrega', 'emprestimo', 'devolucao_emprestimo', 'transferencia', 'envio_reparacao',
    'regresso_reparacao', 'quarentena', 'reserva', 'libertacao_reserva', 'abate', 'rejeicao',
    'extravio', 'ajuste', 'estorno')),
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  garment_id TEXT REFERENCES garments (id),
  size_id TEXT REFERENCES item_sizes (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  from_status TEXT,
  from_condition TEXT,
  from_location_id TEXT REFERENCES locations (id),
  to_status TEXT,
  to_condition TEXT,
  to_location_id TEXT REFERENCES locations (id),
  musician_id TEXT REFERENCES musicians (id),
  ref_type TEXT,
  ref_id TEXT,
  reason TEXT,
  notes TEXT,
  verification TEXT CHECK (verification IS NULL OR verification IN ('contado', 'estimado', 'nao_verificado')),
  reverses_movement_id TEXT REFERENCES stock_movements (id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  CHECK (garment_id IS NULL OR quantity = 1),
  CHECK (garment_id IS NULL OR to_status IS NOT NULL),
  CHECK (from_status IS NOT NULL OR to_status IS NOT NULL),
  CHECK (from_status IS NULL OR from_status IN (
    'disponivel', 'reservado', 'atribuido', 'emprestado', 'pendente_inspecao',
    'quarentena', 'reparacao', 'abatido', 'extraviado', 'rejeitado')),
  CHECK (to_status IS NULL OR to_status IN (
    'disponivel', 'reservado', 'atribuido', 'emprestado', 'pendente_inspecao',
    'quarentena', 'reparacao', 'abatido', 'extraviado', 'rejeitado'))
);
CREATE INDEX movements_garment_idx ON stock_movements (garment_id, seq);
CREATE INDEX movements_type_idx ON stock_movements (item_type_id, size_id, created_at);
CREATE INDEX movements_operation_idx ON stock_movements (operation_id);
CREATE INDEX movements_ref_idx ON stock_movements (ref_type, ref_id);
CREATE INDEX movements_musician_idx ON stock_movements (musician_id);
CREATE INDEX movements_created_idx ON stock_movements (created_at);
CREATE UNIQUE INDEX movements_reverses_uq ON stock_movements (reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;

-- Imutabilidade dos movimentos
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'MOVIMENTO_IMUTAVEL');
END;

CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'MOVIMENTO_IMUTAVEL');
END;

-- Atribuição do código da peça (sequência global, nunca reutilizada)
CREATE TRIGGER garments_before_insert BEFORE INSERT ON garments
BEGIN
  SELECT RAISE(ABORT, 'ESTADO_SEM_MOVIMENTO') WHERE NEW.status IS NOT NULL;
  SELECT RAISE(ABORT, 'TIPO_NAO_INDIVIDUAL')
    WHERE (SELECT tracking_mode FROM item_types WHERE id = NEW.item_type_id) IS NOT 'individual';
  SELECT RAISE(ABORT, 'TIPO_SEM_STOCK')
    WHERE (SELECT stock_enabled FROM item_types WHERE id = NEW.item_type_id) IS NOT 1;
  SELECT RAISE(ABORT, 'TAMANHO_INVALIDO')
    WHERE NEW.size_id IS NOT NULL
      AND (SELECT item_type_id FROM item_sizes WHERE id = NEW.size_id) IS NOT NEW.item_type_id;
END;

CREATE TRIGGER garments_after_insert AFTER INSERT ON garments
BEGIN
  UPDATE code_sequences SET last_value = last_value + 1 WHERE name = 'garment';
  UPDATE garments
    SET serial = (SELECT last_value FROM code_sequences WHERE name = 'garment'),
        code = (SELECT code_prefix FROM item_types WHERE id = NEW.item_type_id) || '-' ||
               printf('%05d', (SELECT last_value FROM code_sequences WHERE name = 'garment'))
    WHERE id = NEW.id;
END;

CREATE TRIGGER garments_no_delete BEFORE DELETE ON garments
BEGIN
  SELECT RAISE(ABORT, 'PECA_COM_HISTORICO');
END;

-- O estado de uma peça só pode mudar através de um movimento.
CREATE TRIGGER garments_status_guard BEFORE UPDATE OF status ON garments
WHEN NEW.status IS NOT OLD.status
  AND NEW.status IS NOT (SELECT to_status FROM stock_movements WHERE garment_id = NEW.id ORDER BY seq DESC LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'ESTADO_SEM_MOVIMENTO');
END;

CREATE TRIGGER garments_code_guard BEFORE UPDATE OF serial, code ON garments
WHEN OLD.code IS NOT NULL AND (NEW.code IS NOT OLD.code OR NEW.serial IS NOT OLD.serial)
BEGIN
  SELECT RAISE(ABORT, 'CODIGO_IMUTAVEL');
END;

-- Movimento de peça individual: valida o estado anterior e aplica o novo.
CREATE TRIGGER movements_garment_check BEFORE INSERT ON stock_movements
WHEN NEW.garment_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PECA_INEXISTENTE')
    WHERE NOT EXISTS (SELECT 1 FROM garments WHERE id = NEW.garment_id);
  SELECT RAISE(ABORT, 'TIPO_INCOERENTE')
    WHERE (SELECT item_type_id FROM garments WHERE id = NEW.garment_id) IS NOT NEW.item_type_id;
  SELECT RAISE(ABORT, 'ESTADO_PECA_ALTERADO')
    WHERE (SELECT status FROM garments WHERE id = NEW.garment_id) IS NOT NEW.from_status;
END;

CREATE TRIGGER movements_garment_apply AFTER INSERT ON stock_movements
WHEN NEW.garment_id IS NOT NULL
BEGIN
  UPDATE garments SET
    status = NEW.to_status,
    condition = COALESCE(NEW.to_condition, condition),
    location_id = NEW.to_location_id,
    holder_musician_id = CASE WHEN NEW.to_status IN ('atribuido', 'emprestado') THEN NEW.musician_id ELSE NULL END,
    verification = COALESCE(NEW.verification, verification),
    updated_at = NEW.created_at
  WHERE id = NEW.garment_id;
END;

-- Movimento por quantidade: valida o saldo de origem e aplica a transferência.
CREATE TRIGGER movements_quantity_check BEFORE INSERT ON stock_movements
WHEN NEW.garment_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'TIPO_NAO_QUANTIDADE')
    WHERE (SELECT tracking_mode FROM item_types WHERE id = NEW.item_type_id) IS NOT 'quantidade';
  SELECT RAISE(ABORT, 'TIPO_SEM_STOCK')
    WHERE (SELECT stock_enabled FROM item_types WHERE id = NEW.item_type_id) IS NOT 1;
  SELECT RAISE(ABORT, 'CONDICAO_OBRIGATORIA')
    WHERE (NEW.from_status IS NOT NULL AND NEW.from_condition IS NULL)
       OR (NEW.to_status IS NOT NULL AND NEW.to_condition IS NULL);
  SELECT RAISE(ABORT, 'TAMANHO_INVALIDO')
    WHERE NEW.size_id IS NOT NULL
      AND (SELECT item_type_id FROM item_sizes WHERE id = NEW.size_id) IS NOT NEW.item_type_id;
  SELECT RAISE(ABORT, 'STOCK_INSUFICIENTE')
    WHERE NEW.from_status IS NOT NULL
      AND COALESCE((SELECT quantity FROM stock_balances WHERE bucket_key =
            NEW.item_type_id || '|' || COALESCE(NEW.size_id, '') || '|' || NEW.from_condition || '|' ||
            COALESCE(NEW.from_location_id, '') || '|' || NEW.from_status), 0) < NEW.quantity;
END;

CREATE TRIGGER movements_quantity_apply AFTER INSERT ON stock_movements
WHEN NEW.garment_id IS NULL
BEGIN
  UPDATE stock_balances
    SET quantity = quantity - NEW.quantity, updated_at = NEW.created_at
    WHERE NEW.from_status IS NOT NULL
      AND bucket_key = NEW.item_type_id || '|' || COALESCE(NEW.size_id, '') || '|' || NEW.from_condition || '|' ||
                       COALESCE(NEW.from_location_id, '') || '|' || NEW.from_status;
  INSERT INTO stock_balances (bucket_key, item_type_id, size_id, condition, location_id, status, quantity, verification, updated_at)
    SELECT NEW.item_type_id || '|' || COALESCE(NEW.size_id, '') || '|' || NEW.to_condition || '|' ||
             COALESCE(NEW.to_location_id, '') || '|' || NEW.to_status,
           NEW.item_type_id, NEW.size_id, NEW.to_condition, NEW.to_location_id, NEW.to_status,
           NEW.quantity, COALESCE(NEW.verification, 'contado'), NEW.created_at
    WHERE NEW.to_status IS NOT NULL
    ON CONFLICT (bucket_key) DO UPDATE SET
      quantity = quantity + excluded.quantity,
      updated_at = excluded.updated_at,
      verification = CASE WHEN excluded.verification = 'estimado' THEN 'estimado' ELSE stock_balances.verification END;
END;

-- O modo de gestão de um tipo só pode mudar se não existir stock desse tipo,
-- impedindo que a mesma unidade física exista como peça e como quantidade.
CREATE TRIGGER item_types_mode_guard BEFORE UPDATE OF tracking_mode, stock_enabled ON item_types
WHEN (NEW.tracking_mode IS NOT OLD.tracking_mode OR NEW.stock_enabled IS NOT OLD.stock_enabled)
  AND (EXISTS (SELECT 1 FROM garments WHERE item_type_id = NEW.id)
       OR EXISTS (SELECT 1 FROM stock_movements WHERE item_type_id = NEW.id))
BEGIN
  SELECT RAISE(ABORT, 'TIPO_COM_STOCK');
END;

-- ---------------------------------------------------------------------
-- Entregas de fardamento novo aos músicos
-- ---------------------------------------------------------------------
CREATE TABLE musician_deliveries (
  id TEXT PRIMARY KEY,
  musician_id TEXT NOT NULL REFERENCES musicians (id),
  delivered_at TEXT NOT NULL,
  delivered_by TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'concluida' CHECK (status IN ('concluida', 'anulada')),
  received_by_name TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX deliveries_musician_idx ON musician_deliveries (musician_id, delivered_at);

CREATE TABLE musician_delivery_lines (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES musician_deliveries (id),
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  garment_id TEXT REFERENCES garments (id),
  size_id TEXT REFERENCES item_sizes (id),
  condition TEXT NOT NULL,
  from_location_id TEXT REFERENCES locations (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  request_id TEXT REFERENCES musician_item_requests (id),
  status TEXT NOT NULL DEFAULT 'entregue' CHECK (status IN ('entregue', 'anulada')),
  returned_quantity INTEGER NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  receipt_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (receipt_confirmed IN (0, 1)),
  receipt_confirmed_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  CHECK (garment_id IS NULL OR quantity = 1),
  CHECK (returned_quantity <= quantity)
);
CREATE INDEX delivery_lines_delivery_idx ON musician_delivery_lines (delivery_id);
CREATE INDEX delivery_lines_request_idx ON musician_delivery_lines (request_id);
CREATE INDEX delivery_lines_garment_idx ON musician_delivery_lines (garment_id);

-- Não permitir entregar mais do que a necessidade registada.
CREATE TRIGGER delivery_lines_request_guard BEFORE INSERT ON musician_delivery_lines
WHEN NEW.request_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'NECESSIDADE_INVALIDA')
    WHERE NOT EXISTS (
      SELECT 1 FROM musician_item_requests r
      JOIN musician_deliveries d ON d.id = NEW.delivery_id
      WHERE r.id = NEW.request_id AND r.musician_id = d.musician_id
        AND r.item_type_id = NEW.item_type_id AND r.status = 'ativa');
  SELECT RAISE(ABORT, 'ENTREGA_EXCEDE_NECESSIDADE')
    WHERE (SELECT COALESCE(SUM(quantity), 0) FROM musician_delivery_lines
           WHERE request_id = NEW.request_id AND status = 'entregue') + NEW.quantity
        > (SELECT quantity_requested FROM musician_item_requests WHERE id = NEW.request_id);
END;

-- ---------------------------------------------------------------------
-- Recolha e inspeção de fardamento antigo
-- ---------------------------------------------------------------------
CREATE TABLE garment_returns (
  id TEXT PRIMARY KEY,
  musician_id TEXT NOT NULL REFERENCES musicians (id),
  received_at TEXT NOT NULL,
  received_by TEXT NOT NULL REFERENCES users (id),
  initial_observations TEXT,
  inspection_status TEXT NOT NULL DEFAULT 'pendente' CHECK (inspection_status IN ('pendente', 'em_curso', 'concluida')),
  notes TEXT,
  decided_by TEXT REFERENCES users (id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX returns_musician_idx ON garment_returns (musician_id);
CREATE INDEX returns_status_idx ON garment_returns (inspection_status, received_at);

CREATE TABLE garment_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES garment_returns (id),
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  garment_id TEXT REFERENCES garments (id),
  size_id TEXT REFERENCES item_sizes (id),
  size_text TEXT,
  inscription TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  observed_condition TEXT NOT NULL CHECK (observed_condition IN ('novo', 'bom', 'razoavel', 'mau', 'inutilizavel')),
  location_id TEXT REFERENCES locations (id),
  delivery_line_id TEXT REFERENCES musician_delivery_lines (id),
  inspected_condition TEXT CHECK (inspected_condition IS NULL OR inspected_condition IN ('novo', 'bom', 'razoavel', 'mau', 'inutilizavel')),
  inspection_result TEXT,
  proposed_destination TEXT CHECK (proposed_destination IS NULL OR proposed_destination IN (
    'disponivel', 'quarentena', 'reparacao', 'reservado', 'abatido', 'rejeitado')),
  proposed_by TEXT REFERENCES users (id),
  proposed_at TEXT,
  approved_destination TEXT CHECK (approved_destination IS NULL OR approved_destination IN (
    'disponivel', 'quarentena', 'reparacao', 'reservado', 'abatido', 'rejeitado')),
  destination_location_id TEXT REFERENCES locations (id),
  decided_by TEXT REFERENCES users (id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (garment_id IS NULL OR quantity = 1)
);
CREATE INDEX return_lines_return_idx ON garment_return_lines (return_id);
CREATE INDEX return_lines_garment_idx ON garment_return_lines (garment_id);

-- Uma decisão de destino é definitiva.
CREATE TRIGGER return_lines_decision_guard BEFORE UPDATE OF approved_destination ON garment_return_lines
WHEN OLD.approved_destination IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DECISAO_JA_TOMADA');
END;

-- ---------------------------------------------------------------------
-- Campanhas, festas e empréstimos
-- ---------------------------------------------------------------------
CREATE TABLE festival_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planeada' CHECK (status IN ('planeada', 'ativa', 'concluida', 'cancelada')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES festival_campaigns (id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  place TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planeada' CHECK (status IN ('planeada', 'ativa', 'encerrada', 'cancelada')),
  notes TEXT,
  closed_at TEXT,
  closed_by TEXT REFERENCES users (id),
  closed_with_pending INTEGER NOT NULL DEFAULT 0 CHECK (closed_with_pending IN (0, 1)),
  closing_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX events_campaign_idx ON events (campaign_id);
CREATE INDEX events_dates_idx ON events (start_date);

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id),
  musician_id TEXT NOT NULL REFERENCES musicians (id),
  delivered_at TEXT NOT NULL,
  delivered_by TEXT NOT NULL REFERENCES users (id),
  due_date TEXT,
  notes TEXT,
  closed_at TEXT,
  closed_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX loans_event_idx ON loans (event_id);
CREATE INDEX loans_musician_idx ON loans (musician_id);
CREATE INDEX loans_due_idx ON loans (due_date);

CREATE TABLE loan_lines (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans (id),
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  garment_id TEXT REFERENCES garments (id),
  size_id TEXT REFERENCES item_sizes (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  out_condition TEXT NOT NULL CHECK (out_condition IN ('novo', 'bom', 'razoavel', 'mau', 'inutilizavel')),
  out_location_id TEXT REFERENCES locations (id),
  delivered_at TEXT NOT NULL,
  delivered_by TEXT NOT NULL REFERENCES users (id),
  returned_quantity INTEGER NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  lost_quantity INTEGER NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
  last_return_condition TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  CHECK (garment_id IS NULL OR quantity = 1),
  CHECK (returned_quantity + lost_quantity <= quantity)
);
CREATE INDEX loan_lines_loan_idx ON loan_lines (loan_id);
CREATE INDEX loan_lines_garment_idx ON loan_lines (garment_id);

CREATE TABLE loan_returns (
  id TEXT PRIMARY KEY,
  loan_line_id TEXT NOT NULL REFERENCES loan_lines (id),
  kind TEXT NOT NULL DEFAULT 'devolucao' CHECK (kind IN ('devolucao', 'perda')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  condition TEXT CHECK (condition IS NULL OR condition IN ('novo', 'bom', 'razoavel', 'mau', 'inutilizavel')),
  damaged INTEGER NOT NULL DEFAULT 0 CHECK (damaged IN (0, 1)),
  destination_status TEXT NOT NULL,
  location_id TEXT REFERENCES locations (id),
  received_at TEXT NOT NULL,
  received_by TEXT NOT NULL REFERENCES users (id),
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX loan_returns_line_idx ON loan_returns (loan_line_id);

-- ---------------------------------------------------------------------
-- Ocorrências (danos, perdas, outras situações)
-- ---------------------------------------------------------------------
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dano', 'perda', 'furto', 'outro')),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  garment_id TEXT REFERENCES garments (id),
  musician_id TEXT REFERENCES musicians (id),
  loan_id TEXT REFERENCES loans (id),
  event_id TEXT REFERENCES events (id),
  return_id TEXT REFERENCES garment_returns (id),
  occurred_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL
);
CREATE INDEX incidents_garment_idx ON incidents (garment_id);
CREATE INDEX incidents_loan_idx ON incidents (loan_id);

-- ---------------------------------------------------------------------
-- Contagens físicas de inventário
-- ---------------------------------------------------------------------
CREATE TABLE inventory_counts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_id TEXT REFERENCES locations (id),
  item_type_id TEXT REFERENCES item_types (id),
  status TEXT NOT NULL DEFAULT 'em_curso' CHECK (status IN ('em_curso', 'confirmada', 'cancelada')),
  notes TEXT,
  reason TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  confirmed_by TEXT REFERENCES users (id),
  confirmed_at TEXT
);

CREATE TABLE inventory_count_lines (
  id TEXT PRIMARY KEY,
  count_id TEXT NOT NULL REFERENCES inventory_counts (id),
  kind TEXT NOT NULL CHECK (kind IN ('quantidade', 'peca')),
  item_type_id TEXT NOT NULL REFERENCES item_types (id),
  size_id TEXT REFERENCES item_sizes (id),
  condition TEXT,
  location_id TEXT REFERENCES locations (id),
  status TEXT,
  garment_id TEXT REFERENCES garments (id),
  expected_quantity INTEGER NOT NULL DEFAULT 0 CHECK (expected_quantity >= 0),
  counted_quantity INTEGER CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  applied_delta INTEGER,
  notes TEXT,
  updated_at TEXT NOT NULL,
  CHECK (kind = 'quantidade' OR garment_id IS NOT NULL),
  CHECK (kind = 'quantidade' OR counted_quantity IS NULL OR counted_quantity IN (0, 1))
);
CREATE INDEX count_lines_count_idx ON inventory_count_lines (count_id);

-- ---------------------------------------------------------------------
-- Anexos (fotografias) — ficheiros privados no R2
-- ---------------------------------------------------------------------
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'garment', 'musician', 'return', 'return_line', 'loan', 'loan_line', 'event', 'incident', 'delivery')),
  entity_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  thumb_r2_key TEXT,
  content_type TEXT NOT NULL,
  original_name TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  width INTEGER,
  height INTEGER,
  caption TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users (id),
  uploaded_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users (id)
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);

-- ---------------------------------------------------------------------
-- Auditoria (imutável)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users (id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_user_idx ON audit_logs (user_id, created_at);
CREATE INDEX audit_created_idx ON audit_logs (created_at);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'AUDITORIA_IMUTAVEL');
END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'AUDITORIA_IMUTAVEL');
END;

-- Proteção de registos com histórico: músicos não podem ser apagados.
CREATE TRIGGER musicians_no_delete BEFORE DELETE ON musicians
BEGIN
  SELECT RAISE(ABORT, 'REGISTO_COM_HISTORICO');
END;

-- ---------------------------------------------------------------------
-- Vistas de apoio (cálculos derivados — não guardam dados)
-- ---------------------------------------------------------------------
CREATE VIEW v_request_progress AS
SELECT r.*,
       COALESCE((SELECT SUM(dl.quantity) FROM musician_delivery_lines dl
                  WHERE dl.request_id = r.id AND dl.status = 'entregue'), 0) AS quantity_delivered
  FROM musician_item_requests r;

CREATE VIEW v_loan_lines AS
SELECT ll.*, ll.quantity - ll.returned_quantity - ll.lost_quantity AS pending_quantity
  FROM loan_lines ll;

CREATE VIEW v_musician_returns AS
SELECT r.musician_id, rl.item_type_id, SUM(rl.quantity) AS returned_quantity
  FROM garment_return_lines rl JOIN garment_returns r ON r.id = rl.return_id
 GROUP BY r.musician_id, rl.item_type_id;
