-- Migração 0004: todos os artigos de fardamento passam a ser geridos peça a peça
-- (código próprio e etiqueta QR), como os casacos.
-- Só altera tipos que ainda não têm stock nem movimentos: um tipo com stock registado
-- mantém o modo atual (o trigger item_types_mode_guard impediria a alteração).
UPDATE item_types
   SET tracking_mode = 'individual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE stock_enabled = 1
   AND tracking_mode = 'quantidade'
   AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.item_type_id = item_types.id)
   AND NOT EXISTS (SELECT 1 FROM garments g WHERE g.item_type_id = item_types.id);
