/**
 * Configuração do Jest para testes do bot TypeScript
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/bot', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'bot/**/*.ts',
    '!bot/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
