export interface Attendee {
  id?: string;
  Nombre: string;
  Apellidos: string;
  'Correo electrónico': string;
  'Fecha de compra': string;
  'Tipo de entrada': string;
  'Precio original': string;
  'Gastos de gestion': string;
  'Cupon usado': string;
  'Codigo del cupon': string;
  'Descuento aplicado': string;
  'Precio pagado': string;
  'Ticket ID': string;
  'Código QR': string;
  'Pregunta en Checkout': string;
  'Respuesta en Checkout': string;
  validated: boolean;
  validationTime?: string;
  validatedBy?: string;
}

export interface Event {
  id: string;
  name: string;
  createdAt: any;
  password?: string;
}

export type Tab = 'scan' | 'list' | 'events';
