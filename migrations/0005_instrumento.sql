-- Migração 0005: instrumento de cada músico.
ALTER TABLE musicians ADD COLUMN instrument TEXT;
CREATE INDEX musicians_instrument_idx ON musicians (instrument);
