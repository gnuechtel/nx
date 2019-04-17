import { Tree } from '@angular-devkit/schematics';

import { readJsonInTree } from '@nrwl/schematics';
import { createEmptyWorkspace } from '@nrwl/schematics/testing';

import { runSchematic } from '../../utils/testing';

describe('ng-add', () => {
  let appTree: Tree;

  beforeEach(() => {
    appTree = Tree.empty();
    appTree = createEmptyWorkspace(appTree);
  });

  it('should add dependencies into `package.json` file', async () => {
    const tree = await runSchematic('ng-add', {}, appTree);
    const packageJson = readJsonInTree(tree, 'package.json');

    expect(packageJson.devDependencies.cypress).toBeDefined();
    expect(packageJson.devDependencies['@nrwl/cypress']).toBeDefined();
  });
});
