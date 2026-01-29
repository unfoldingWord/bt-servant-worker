/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    // ===========================================
    // NO CIRCULAR DEPENDENCIES
    // ===========================================
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about',
      from: {},
      to: {
        circular: true,
      },
    },

    // ===========================================
    // ONION ARCHITECTURE
    // ===========================================

    // Types should have no internal dependencies
    {
      name: 'types-no-dependencies',
      severity: 'error',
      comment: 'Types should be pure and have no internal dependencies',
      from: {
        path: '^src/types',
      },
      to: {
        path: '^src/(routes|services|durable-objects)',
      },
    },

    // Services cannot import from routes
    {
      name: 'services-no-routes',
      severity: 'error',
      comment: 'Services cannot depend on routes',
      from: {
        path: '^src/services',
      },
      to: {
        path: '^src/routes',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
