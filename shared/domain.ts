// Domínio partilhado entre o frontend e o Worker: estados, etiquetas e permissões.

export const ROLES = ['admin', 'gestor', 'consulta'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  gestor: 'Responsável pelo fardamento',
  consulta: 'Consulta',
};

export const PERMISSIONS = [
  'read',
  'export',
  'musicians.write',
  'requests.write',
  'deliveries.write',
  'returns.write',
  'returns.inspect',
  'inventory.write',
  'inventory.writeoff',
  'inventory.adjust',
  'inventory.reverse',
  'events.write',
  'loans.write',
  'attachments.write',
  'settings.manage',
  'users.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GESTOR: Permission[] = [
  'read',
  'export',
  'musicians.write',
  'requests.write',
  'deliveries.write',
  'returns.write',
  'returns.inspect',
  'inventory.write',
  'inventory.writeoff',
  'events.write',
  'loans.write',
  'attachments.write',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  gestor: GESTOR,
  consulta: ['read', 'export'],
};

export function can(role: Role | undefined | null, perm: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(perm);
}

// --- Estados operacionais ------------------------------------------------
export const STATUSES = [
  'disponivel',
  'reservado',
  'atribuido',
  'emprestado',
  'pendente_inspecao',
  'quarentena',
  'reparacao',
  'abatido',
  'extraviado',
  'rejeitado',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  disponivel: 'Disponível',
  reservado: 'Reservado',
  atribuido: 'Atribuído a músico',
  emprestado: 'Emprestado',
  pendente_inspecao: 'Pendente de inspeção',
  quarentena: 'Em quarentena',
  reparacao: 'Em reparação',
  abatido: 'Abatido',
  extraviado: 'Extraviado',
  rejeitado: 'Rejeitado',
};

/** Estados que correspondem a peças fisicamente existentes e na posse da banda (armazém/reparação). */
export const IN_HOUSE_STATUSES: Status[] = ['disponivel', 'reservado', 'pendente_inspecao', 'quarentena', 'reparacao'];
/** Estados de peças que deixaram de existir no inventário ativo. */
export const OUT_STATUSES: Status[] = ['abatido', 'extraviado', 'rejeitado'];
/** Estados contáveis numa contagem física no armazém. */
export const COUNTABLE_STATUSES: Status[] = ['disponivel', 'reservado', 'pendente_inspecao', 'quarentena'];

// --- Estado de conservação ------------------------------------------------
export const CONDITIONS = ['novo', 'bom', 'razoavel', 'mau', 'inutilizavel'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABELS: Record<Condition, string> = {
  novo: 'Novo',
  bom: 'Bom',
  razoavel: 'Razoável',
  mau: 'Mau',
  inutilizavel: 'Inutilizável',
};

export const ORIGINS = ['stock_inicial', 'devolucao_musico', 'aquisicao_nova', 'devolucao_emprestimo', 'doacao', 'outra'] as const;
export type Origin = (typeof ORIGINS)[number];
export const ORIGIN_LABELS: Record<Origin, string> = {
  stock_inicial: 'Stock inicial',
  devolucao_musico: 'Devolução de músico',
  aquisicao_nova: 'Aquisição nova',
  devolucao_emprestimo: 'Devolução de empréstimo',
  doacao: 'Doação',
  outra: 'Outra origem',
};

export const VERIFICATIONS = ['contado', 'estimado', 'nao_verificado'] as const;
export type Verification = (typeof VERIFICATIONS)[number];
export const VERIFICATION_LABELS: Record<Verification, string> = {
  contado: 'Contado',
  estimado: 'Estimado',
  nao_verificado: 'Não verificado',
};

// --- Movimentos -------------------------------------------------------------
export const MOVEMENT_TYPES = [
  'stock_inicial',
  'rececao_nova',
  'recolha_musico',
  'aprovacao_entrada',
  'entrega_musico',
  'anulacao_entrega',
  'emprestimo',
  'devolucao_emprestimo',
  'transferencia',
  'envio_reparacao',
  'regresso_reparacao',
  'quarentena',
  'reserva',
  'libertacao_reserva',
  'abate',
  'rejeicao',
  'extravio',
  'ajuste',
  'estorno',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export const MOVEMENT_LABELS: Record<MovementType, string> = {
  stock_inicial: 'Entrada de stock inicial',
  rececao_nova: 'Receção de artigos novos',
  recolha_musico: 'Recolha de fardamento antigo',
  aprovacao_entrada: 'Aprovação de entrada em stock',
  entrega_musico: 'Entrega a músico',
  anulacao_entrega: 'Anulação de entrega',
  emprestimo: 'Empréstimo',
  devolucao_emprestimo: 'Devolução de empréstimo',
  transferencia: 'Transferência de localização',
  envio_reparacao: 'Envio para reparação',
  regresso_reparacao: 'Regresso da reparação',
  quarentena: 'Quarentena',
  reserva: 'Reserva',
  libertacao_reserva: 'Libertação de reserva',
  abate: 'Abate',
  rejeicao: 'Rejeição de entrada',
  extravio: 'Extravio',
  ajuste: 'Ajuste de inventário',
  estorno: 'Estorno',
};

/** Tipos de movimento que podem ser estornados diretamente (sem documento de negócio associado). */
export const REVERSIBLE_MOVEMENTS: MovementType[] = [
  'stock_inicial',
  'rececao_nova',
  'transferencia',
  'envio_reparacao',
  'regresso_reparacao',
  'quarentena',
  'reserva',
  'libertacao_reserva',
  'abate',
  'extravio',
  'ajuste',
];

// --- Destinos de inspeção ---------------------------------------------------
export const INSPECTION_DESTINATIONS = ['disponivel', 'quarentena', 'reparacao', 'reservado', 'abatido', 'rejeitado'] as const;
export type InspectionDestination = (typeof INSPECTION_DESTINATIONS)[number];
export const DESTINATION_LABELS: Record<InspectionDestination, string> = {
  disponivel: 'Reintegrar no stock disponível',
  quarentena: 'Colocar em quarentena',
  reparacao: 'Enviar para reparação',
  reservado: 'Manter reservado',
  abatido: 'Abater',
  rejeitado: 'Rejeitar a entrada em stock',
};
export const DESTINATION_MOVEMENT: Record<InspectionDestination, MovementType> = {
  disponivel: 'aprovacao_entrada',
  quarentena: 'quarentena',
  reparacao: 'envio_reparacao',
  reservado: 'reserva',
  abatido: 'abate',
  rejeitado: 'rejeicao',
};

/** Mudanças de estado manuais permitidas no inventário: origem -> destinos. */
export const INVENTORY_TRANSITIONS: Partial<Record<Status, Status[]>> = {
  disponivel: ['reservado', 'quarentena', 'reparacao', 'abatido', 'extraviado'],
  reservado: ['disponivel', 'quarentena', 'reparacao', 'abatido', 'extraviado'],
  pendente_inspecao: ['disponivel', 'reservado', 'quarentena', 'reparacao', 'abatido', 'rejeitado'],
  quarentena: ['disponivel', 'reservado', 'reparacao', 'abatido', 'extraviado'],
  reparacao: ['disponivel', 'quarentena', 'reservado', 'abatido', 'extraviado'],
};

export function transitionMovementType(from: Status, to: Status): MovementType {
  if (from === 'reparacao' && to !== 'abatido' && to !== 'extraviado') return 'regresso_reparacao';
  if (from === 'reservado' && to === 'disponivel') return 'libertacao_reserva';
  if (from === 'pendente_inspecao' && to === 'disponivel') return 'aprovacao_entrada';
  if (from === 'quarentena' && to === 'disponivel') return 'aprovacao_entrada';
  switch (to) {
    case 'reservado':
      return 'reserva';
    case 'quarentena':
      return 'quarentena';
    case 'reparacao':
      return 'envio_reparacao';
    case 'abatido':
      return 'abate';
    case 'extraviado':
      return 'extravio';
    case 'rejeitado':
      return 'rejeicao';
    default:
      return 'ajuste';
  }
}

// --- Músicos e necessidades -------------------------------------------------
export const MUSICIAN_KINDS = ['banda', 'convidado'] as const;
export type MusicianKind = (typeof MUSICIAN_KINDS)[number];
export const MUSICIAN_KIND_LABELS: Record<MusicianKind, string> = { banda: 'Músico da banda', convidado: 'Músico convidado' };
/** Sugestões de instrumentos (o campo aceita qualquer texto). */
export const INSTRUMENT_SUGGESTIONS = [
  'Flautim',
  'Flauta',
  'Oboé',
  'Fagote',
  'Requinta',
  'Clarinete',
  'Clarinete baixo',
  'Saxofone soprano',
  'Saxofone alto',
  'Saxofone tenor',
  'Saxofone barítono',
  'Trompete',
  'Fliscorne',
  'Trompa',
  'Trombone',
  'Bombardino',
  'Tuba',
  'Contrabaixo',
  'Caixa',
  'Bombo',
  'Pratos',
  'Percussão',
  'Timbales',
  'Glockenspiel',
  'Xilofone',
  'Maestro',
  'Porta-estandarte',
];

export const MUSICIAN_STATUSES = ['ativo', 'inativo', 'arquivado'] as const;
export type MusicianStatus = (typeof MUSICIAN_STATUSES)[number];
export const MUSICIAN_STATUS_LABELS: Record<MusicianStatus, string> = { ativo: 'Ativo', inativo: 'Inativo', arquivado: 'Arquivado' };

export const REQUEST_STATUSES = ['ativa', 'cancelada', 'por_avaliar', 'confirmada', 'resolvida'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const SHOE_REQUEST_STATUSES: RequestStatus[] = ['por_avaliar', 'confirmada', 'resolvida', 'cancelada'];
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  ativa: 'Ativa',
  cancelada: 'Cancelada',
  por_avaliar: 'Por avaliar',
  confirmada: 'Necessidade confirmada',
  resolvida: 'Resolvida',
};
/** Estado calculado de uma necessidade de aquisição. */
export const REQUEST_PROGRESS_LABELS: Record<string, string> = {
  pendente: 'Pendente',
  encomendada: 'Encomendada',
  recebida: 'Recebida',
  parcial: 'Entregue parcialmente',
  entregue: 'Entregue',
  cancelada: 'Cancelada',
};

export const CAMPAIGN_STATUSES = ['planeada', 'ativa', 'concluida', 'cancelada'] as const;
export const CAMPAIGN_STATUS_LABELS: Record<(typeof CAMPAIGN_STATUSES)[number], string> = {
  planeada: 'Planeada',
  ativa: 'Ativa',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};
export const EVENT_STATUSES = ['planeada', 'ativa', 'encerrada', 'cancelada'] as const;
export const EVENT_STATUS_LABELS: Record<(typeof EVENT_STATUSES)[number], string> = {
  planeada: 'Planeada',
  ativa: 'A decorrer',
  encerrada: 'Encerrada',
  cancelada: 'Cancelada',
};
export const LOAN_STATE_LABELS: Record<string, string> = {
  aberto: 'Por devolver',
  parcial: 'Devolvido parcialmente',
  devolvido: 'Devolvido',
  com_perdas: 'Fechado com perdas',
  encerrado: 'Encerrado com pendências',
};

export const INCIDENT_KINDS = ['dano', 'perda', 'furto', 'outro'] as const;
export const INCIDENT_KIND_LABELS: Record<(typeof INCIDENT_KINDS)[number], string> = {
  dano: 'Dano',
  perda: 'Perda',
  furto: 'Furto',
  outro: 'Outro',
};

export const TRACKING_LABELS = { individual: 'Peça individual (com código)', quantidade: 'Por quantidade' } as const;
export const SIZE_KIND_LABELS = { alfanumerico: 'Alfanumérico (XS, S, M…)', numerico: 'Numérico', livre: 'Livre' } as const;

export const ATTACHMENT_ENTITY_TYPES = [
  'garment',
  'musician',
  'return',
  'return_line',
  'loan',
  'loan_line',
  'event',
  'incident',
  'delivery',
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const SETUP_STEPS = [
  { key: 'admin', label: 'Criar o primeiro administrador' },
  { key: 'item_types', label: 'Configurar os tipos de artigo e tamanhos' },
  { key: 'statuses', label: 'Confirmar estados de conservação e operacionais' },
  { key: 'locations', label: 'Registar localizações físicas' },
  { key: 'initial_stock', label: 'Introduzir o stock inicial' },
  { key: 'musicians', label: 'Registar músicos e necessidades' },
] as const;

export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
