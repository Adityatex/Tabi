// Playwright errors include full request headers, so an API key can end up in
// anything the harness prints. Every error message goes through this first.

export function redact(text: string): string {
  return text
    .replace(/gsk_[A-Za-z0-9]+/g, 'gsk_***') // Groq
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***') // OpenAI, DeepSeek, OpenRouter (sk-or-...)
    .replace(/org_[A-Za-z0-9]+/g, 'org_***')
    .replace(/(authorization:\s*Bearer\s+)\S+/gi, '$1***');
}
