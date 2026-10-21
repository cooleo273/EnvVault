/**
 * Hands text to the browser as a file download. The Blob URL is revoked
 * right after the click, so nothing stays addressable once the browser has
 * the file; the content is never written to storage.
 */
export function downloadText(filename: string, mediaType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}
