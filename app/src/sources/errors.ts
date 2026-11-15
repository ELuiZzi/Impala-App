/** El usuario canceló el borrado en el diálogo del sistema: no es un error que mostrar. */
export class DeleteCancelledError extends Error {
  constructor() {
    super('Borrado cancelado');
    this.name = 'DeleteCancelledError';
  }
}
