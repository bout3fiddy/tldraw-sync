import { useEffect, useState } from 'react'
import { Notice } from './notice'
import { use_print } from './print_engine'

const notice_ms = 4000

export function use_notice(): [string, (text: string) => void] {
  const [notice, notice_set] = useState('')
  useEffect(() => {
    if (notice === '') return

    const timer = window.setTimeout(() => notice_set(''), notice_ms)
    return () => window.clearTimeout(timer)
  }, [notice])
  return [notice, notice_set]
}

export function PrintNotice({ notice = '' }: { notice?: string }) {
  const failed = use_print()?.view?.failed ?? 0
  const text = notice || (failed > 0 ? `Agent drawing: ${failed} not shown.` : '')
  return text ? <Notice floating text={text} /> : null
}
