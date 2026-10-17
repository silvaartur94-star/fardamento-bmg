-- Migração 0003: eliminação de músicos sem histórico e medidas dos músicos.

-- Um músico só pode ser apagado se não tiver qualquer histórico de fardamento.
DROP TRIGGER musicians_no_delete;
CREATE TRIGGER musicians_no_delete BEFORE DELETE ON musicians
WHEN EXISTS (SELECT 1 FROM musician_deliveries WHERE musician_id = OLD.id)
  OR EXISTS (SELECT 1 FROM garment_returns WHERE musician_id = OLD.id)
  OR EXISTS (SELECT 1 FROM loans WHERE musician_id = OLD.id)
  OR EXISTS (SELECT 1 FROM stock_movements WHERE musician_id = OLD.id)
  OR EXISTS (SELECT 1 FROM garments WHERE holder_musician_id = OLD.id)
  OR EXISTS (SELECT 1 FROM incidents WHERE musician_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'REGISTO_COM_HISTORICO');
END;

-- Medidas do músico (opcionais), para confeção/escolha de tamanhos.
CREATE TABLE musician_measurements (
  musician_id TEXT PRIMARY KEY REFERENCES musicians (id),
  height_cm REAL CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 250),
  chest_cm REAL CHECK (chest_cm IS NULL OR chest_cm BETWEEN 30 AND 250),
  waist_cm REAL CHECK (waist_cm IS NULL OR waist_cm BETWEEN 30 AND 250),
  hips_cm REAL CHECK (hips_cm IS NULL OR hips_cm BETWEEN 30 AND 250),
  shoulder_cm REAL CHECK (shoulder_cm IS NULL OR shoulder_cm BETWEEN 10 AND 100),
  sleeve_cm REAL CHECK (sleeve_cm IS NULL OR sleeve_cm BETWEEN 10 AND 120),
  inseam_cm REAL CHECK (inseam_cm IS NULL OR inseam_cm BETWEEN 20 AND 150),
  neck_cm REAL CHECK (neck_cm IS NULL OR neck_cm BETWEEN 20 AND 70),
  head_cm REAL CHECK (head_cm IS NULL OR head_cm BETWEEN 30 AND 80),
  shoe_size TEXT,
  notes TEXT,
  measured_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users (id)
);
