'use client'

import { Link } from '@payloadcms/ui'
import type { DefaultCellComponentProps } from 'payload'

import { agentInitial } from './adminStats'

type RowData = DefaultCellComponentProps['rowData'] & {
  avatar?: { alt?: null | string; url?: null | string } | null
  name?: null | string
  templateKey?: null | string
}

export function AgentNameCell({ linkURL, rowData: rawRowData }: DefaultCellComponentProps) {
  const rowData = rawRowData as RowData
  const content = (
    <span className="ae-agent-cell">
      <span className="ae-agent-cell__avatar">
        {rowData.avatar?.url ? (
          // Payload media URLs are controlled by this local admin instance.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={rowData.avatar.alt || ''} src={rowData.avatar.url} />
        ) : (
          agentInitial(rowData.name)
        )}
      </span>
      <span className="ae-agent-cell__copy">
        <strong>{rowData.name || '未命名智能体'}</strong>
        <small>{rowData.templateKey || '—'}</small>
      </span>
    </span>
  )

  return linkURL ? (
    <Link className="ae-agent-cell__link" href={linkURL}>
      {content}
    </Link>
  ) : (
    content
  )
}
