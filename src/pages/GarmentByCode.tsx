import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, Loading } from '../components/ui';

/** Destino do código QR das etiquetas: /p/CAS-00012 → ficha da peça. */
export default function GarmentByCode() {
  const { code = '' } = useParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['by-code', code], queryFn: () => api.get<{ id: string }>(`/inventory/garments/by-code/${encodeURIComponent(code)}`) });
  useEffect(() => {
    if (q.data) nav(`/inventario/pecas/${q.data.id}`, { replace: true });
  }, [q.data, nav]);
  return q.error ? <ErrorBox error={q.error} /> : <Loading text={`A procurar a peça ${code}…`} />;
}
