/** En el PC no hay avisos de episodios nuevos (la lista de suscripciones muestra cuántos hay). */
export async function askNotificationPermission(): Promise<boolean> {
  return false;
}

export async function notifyNewEpisodes(_added: Record<string, string[]>): Promise<void> {}

export function listenNotificationTaps(_open: (url: string) => void): () => void {
  return () => {};
}
