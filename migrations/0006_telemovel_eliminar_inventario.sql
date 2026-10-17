-- Migração 0006: telemóvel dos músicos, lembretes de devolução e eliminação de peças do inventário.

ALTER TABLE musicians ADD COLUMN phone TEXT;

ALTER TABLE loans ADD COLUMN last_reminder_at TEXT;
ALTER TABLE loans ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;

-- Autorização temporária (dentro da mesma transação) para eliminar uma peça e os seus movimentos.
-- A aplicação só a concede a administradores, para peças sem entregas, empréstimos ou recolhas.
CREATE TABLE purge_authorizations (
  garment_id TEXT PRIMARY KEY
);

DROP TRIGGER stock_movements_no_delete;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
WHEN OLD.garment_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM purge_authorizations WHERE garment_id = OLD.garment_id)
BEGIN
  SELECT RAISE(ABORT, 'MOVIMENTO_IMUTAVEL');
END;

DROP TRIGGER garments_no_delete;
CREATE TRIGGER garments_no_delete BEFORE DELETE ON garments
WHEN NOT EXISTS (SELECT 1 FROM purge_authorizations WHERE garment_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'PECA_COM_HISTORICO');
END;
