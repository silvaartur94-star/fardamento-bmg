-- Migração 0007: registo do fardamento que os músicos já têm em sua posse.
-- 'entrega'   = fardamento entregue a partir do stock da banda;
-- 'existente' = peças que o músico já tinha, registadas na aplicação (não saem do stock).
ALTER TABLE musician_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'entrega' CHECK (kind IN ('entrega', 'existente'));
