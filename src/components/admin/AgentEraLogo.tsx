import Image from 'next/image'

export function AgentEraIcon() {
  return (
    <Image
      alt="Aera"
      className="ae-brand-mark"
      height={30}
      src="/agentera-icon.png"
      width={30}
    />
  )
}

export function AgentEraLogo() {
  return (
    <span className="ae-brand" data-testid="agentera-brand">
      <AgentEraIcon />
      <span>Aera 管理系统</span>
    </span>
  )
}
