module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: false }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@nestjs|@nestjs/common|@nestjs/core|@nestjs/testing|reflect-metadata|rxjs)/)',
  ],
  moduleNameMapper: {
    '^@nestjs/(.*)$': '<rootDir>/node_modules/@nestjs/$1',
  },
};
