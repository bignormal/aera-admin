import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

const eslintConfig = [
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^(_|ignore)',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: false,
          vars: 'all',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    ignores: [
      '.next/**',
      '.next-soybean-e2e/**',
      '.tmp/**',
      '.worktrees/**',
      'admin-web/**',
      'playwright-report/**',
      'src/payload-generated-schema.ts',
      'src/payload-types.ts',
      'test-results/**',
    ],
  },
]

export default eslintConfig
