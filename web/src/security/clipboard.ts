export async function copySensitiveText(value: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (value.length === 0 || !clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('secure clipboard is unavailable');
  }
  await clipboard.writeText(value);
}
