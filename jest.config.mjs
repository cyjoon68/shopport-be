const config = {
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/worker.ts',
    '!src/outbox-worker.ts',
    '!src/image-processor.ts',
    '!src/**/*.d.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { statements: 58, branches: 49, functions: 50, lines: 60 },
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
  extensionsToTreatAsEsm: ['.ts'],
};

export default config;
