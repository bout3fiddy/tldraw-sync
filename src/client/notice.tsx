// The one piece of text either page ever shows about its connection.

export function Notice({ text, floating = false }: { text: string; floating?: boolean }) {
  return (
    <p className={floating ? 'notice notice--floating' : 'notice'} role="status">
      {text}
    </p>
  )
}
