import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { zh } from '@payloadcms/translations/languages/zh'
import path from 'node:path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { Admins } from './collections/Admins'
import { AgentTemplates } from './collections/AgentTemplates'
import { AuditLogs } from './collections/AuditLogs'
import { ExpertCategories } from './collections/ExpertCategories'
import { IntegrationSettings } from './collections/IntegrationSettings'
import { Media } from './collections/Media'
import { OfficialRollbackRequests } from './collections/OfficialRollbackRequests'
import { PetAssets } from './collections/PetAssets'
import { PluginCatalog } from './collections/PluginCatalog'
import { RuntimeCommands } from './collections/RuntimeCommands'
import { RuntimeEvents } from './collections/RuntimeEvents'
import { RuntimeInstances } from './collections/RuntimeInstances'
import { RuntimeReleases } from './collections/RuntimeReleases'
import { SkillCatalog } from './collections/SkillCatalog'
import { catalogEndpoint } from './endpoints/catalog'
import { cloudEndpoints } from './endpoints/cloud'
import { officialRollbackEndpoints } from './endpoints/official-rollback'
import { platformEndpoints } from './endpoints/platform'
import { platformReadinessEndpoint } from './endpoints/platform-readiness'
import { platformStatusEndpoint } from './endpoints/platform-status'
import { runtimeControlEndpoints } from './endpoints/runtime-control'
import { securityEndpoints } from './endpoints/security'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const adminWebURL = process.env.ADMIN_WEB_URL

export default buildConfig({
  admin: {
    user: Admins.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      graphics: {
        Icon: '/components/admin/AgentEraLogo#AgentEraIcon',
        Logo: '/components/admin/AgentEraLogo#AgentEraLogo',
      },
    },
  },
  collections: [
    Admins,
    Media,
    ExpertCategories,
    SkillCatalog,
    AgentTemplates,
    PluginCatalog,
    PetAssets,
    IntegrationSettings,
    AuditLogs,
    OfficialRollbackRequests,
    RuntimeInstances,
    RuntimeReleases,
    RuntimeCommands,
    RuntimeEvents,
  ],
  csrf: adminWebURL ? [adminWebURL] : [],
  db: sqliteAdapter({
    client: {
      url: process.env.DATABASE_URL || 'file:./agentera-admin.db',
    },
    wal: true,
  }),
  editor: lexicalEditor(),
  endpoints: [
    catalogEndpoint,
    platformStatusEndpoint,
    platformReadinessEndpoint,
    ...platformEndpoints,
    ...cloudEndpoints,
    ...officialRollbackEndpoints,
    ...runtimeControlEndpoints,
    ...securityEndpoints,
  ],
  i18n: {
    fallbackLanguage: 'zh',
    supportedLanguages: { zh },
  },
  secret: process.env.PAYLOAD_SECRET || '',
  serverURL: process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3000',
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  plugins: [],
})
