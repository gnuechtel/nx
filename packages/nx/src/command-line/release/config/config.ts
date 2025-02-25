/**
 * `nx release` is a powerful feature which spans many possible use cases. The possible variations
 * of configuration are therefore quite complex, particularly when you consider release groups.
 *
 * We want to provide the best possible DX for users so that they can harness the power of `nx release`
 * most effectively, therefore we need to both provide sensible defaults for common scenarios (to avoid
 * verbose nx.json files wherever possible), and proactively handle potential sources of config issues
 * in more complex use-cases.
 *
 * This file is the source of truth for all `nx release` configuration reconciliation, including sensible
 * defaults and user overrides, as well as handling common errors, up front to produce a single, consistent,
 * and easy to consume config object for all the `nx release` command implementations.
 */
import { NxJsonConfiguration } from '../../../config/nx-json';
import { output, type ProjectGraph } from '../../../devkit-exports';
import { findMatchingProjects } from '../../../utils/find-matching-projects';
import { projectHasTarget } from '../../../utils/project-graph-utils';
import { resolveNxJsonConfigErrorMessage } from '../utils/resolve-nx-json-error-message';

type DeepRequired<T> = Required<{
  [K in keyof T]: T[K] extends Required<T[K]> ? T[K] : DeepRequired<T[K]>;
}>;

type EnsureProjectsArray<T> = {
  [K in keyof T]: T[K] extends { projects: any }
    ? Omit<T[K], 'projects'> & { projects: string[] }
    : T[K];
};

type RemoveTrueFromType<T> = T extends true ? never : T;
type RemoveTrueFromProperties<T, K extends keyof T> = {
  [P in keyof T]: P extends K ? RemoveTrueFromType<T[P]> : T[P];
};
type RemoveTrueFromPropertiesOnEach<T, K extends keyof T[keyof T]> = {
  [U in keyof T]: RemoveTrueFromProperties<T[U], K>;
};

export const IMPLICIT_DEFAULT_RELEASE_GROUP = '__default__';

/**
 * Our source of truth is a deeply required variant of the user-facing config interface, so that command
 * implementations can be sure that properties will exist and do not need to repeat the same checks over
 * and over again.
 *
 * We also normalize the projects property on release groups to always be an array of project names to make
 * it easier to work with (the user could be specifying a single string, and they can also use any valid matcher
 * pattern such as directories and globs).
 */
export type NxReleaseConfig = Omit<
  DeepRequired<
    NxJsonConfiguration['release'] & {
      groups: DeepRequired<
        RemoveTrueFromPropertiesOnEach<
          EnsureProjectsArray<NxJsonConfiguration['release']['groups']>,
          'changelog'
        >
      >;
      // Remove the true shorthand from the changelog config types, it will be normalized to a default object
      changelog: RemoveTrueFromProperties<
        DeepRequired<NxJsonConfiguration['release']['changelog']>,
        'workspaceChangelog' | 'projectChangelogs'
      >;
    }
  >,
  // projects is just a shorthand for the default group's projects configuration, it does not exist in the final config
  'projects'
>;

// We explicitly handle some possible errors in order to provide the best possible DX
export interface CreateNxReleaseConfigError {
  code:
    | 'PROJECTS_AND_GROUPS_DEFINED'
    | 'RELEASE_GROUP_MATCHES_NO_PROJECTS'
    | 'RELEASE_GROUP_RELEASE_TAG_PATTERN_VERSION_PLACEHOLDER_MISSING_OR_EXCESSIVE'
    | 'PROJECT_MATCHES_MULTIPLE_GROUPS'
    | 'PROJECTS_MISSING_TARGET';
  data: Record<string, string | string[]>;
}

// Apply default configuration to any optional user configuration and handle known errors
export async function createNxReleaseConfig(
  projectGraph: ProjectGraph,
  userConfig: NxJsonConfiguration['release'] = {},
  // Optionally ensure that all configured projects have implemented a certain target
  requiredTargetName?: 'nx-release-publish'
): Promise<{
  error: null | CreateNxReleaseConfigError;
  nxReleaseConfig: NxReleaseConfig | null;
}> {
  if (userConfig.projects && userConfig.groups) {
    return {
      error: {
        code: 'PROJECTS_AND_GROUPS_DEFINED',
        data: {},
      },
      nxReleaseConfig: null,
    };
  }

  const gitDefaults = {
    commit: false,
    commitMessage: '',
    commitArgs: '',
    tag: false,
    tagMessage: '',
    tagArgs: '',
  };

  const defaultFixedReleaseTagPattern = 'v{version}';
  const defaultIndependentReleaseTagPattern = '{projectName}@{version}';

  const workspaceProjectsRelationship =
    userConfig.projectsRelationship || 'fixed';

  const WORKSPACE_DEFAULTS: Omit<NxReleaseConfig, 'groups'> = {
    // By default all projects in all groups are released together
    projectsRelationship: workspaceProjectsRelationship,
    git: gitDefaults,
    version: {
      git: gitDefaults,
      generator: '@nx/js:release-version',
      generatorOptions: {},
    },
    changelog: {
      git: gitDefaults,
      workspaceChangelog: {
        createRelease: false,
        entryWhenNoChanges:
          'This was a version bump only, there were no code changes.',
        file: '{workspaceRoot}/CHANGELOG.md',
        renderer: 'nx/changelog-renderer',
        renderOptions: {
          includeAuthors: true,
        },
      },
      // For projectChangelogs if the user has set any changelog config at all, then use one set of defaults, otherwise default to false for the whole feature
      projectChangelogs: userConfig.changelog?.projectChangelogs
        ? {
            createRelease: false,
            file: '{projectRoot}/CHANGELOG.md',
            entryWhenNoChanges:
              'This was a version bump only for {projectName} to align it with other projects, there were no code changes.',
            renderer: 'nx/changelog-renderer',
            renderOptions: {
              includeAuthors: true,
            },
          }
        : false,
    },
    releaseTagPattern:
      userConfig.releaseTagPattern ||
      // The appropriate default releaseTagPattern is dependent upon the projectRelationships
      (workspaceProjectsRelationship === 'independent'
        ? defaultIndependentReleaseTagPattern
        : defaultFixedReleaseTagPattern),
  };

  const groupProjectsRelationship =
    userConfig.projectsRelationship || WORKSPACE_DEFAULTS.projectsRelationship;

  const GROUP_DEFAULTS: Omit<NxReleaseConfig['groups'][string], 'projects'> = {
    projectsRelationship: groupProjectsRelationship,
    version: {
      generator: '@nx/js:release-version',
      generatorOptions: {},
    },
    changelog: {
      createRelease: false,
      entryWhenNoChanges:
        'This was a version bump only for {projectName} to align it with other projects, there were no code changes.',
      file: '{projectRoot}/CHANGELOG.md',
      renderer: 'nx/changelog-renderer',
      renderOptions: {
        includeAuthors: true,
      },
    },
    releaseTagPattern:
      // The appropriate group default releaseTagPattern is dependent upon the projectRelationships
      groupProjectsRelationship === 'independent'
        ? defaultIndependentReleaseTagPattern
        : WORKSPACE_DEFAULTS.releaseTagPattern,
  };

  /**
   * We first process root level config and apply defaults, so that we know how to handle the group level
   * overrides, if applicable.
   */
  const rootGitConfig: NxReleaseConfig['git'] = deepMergeDefaults(
    [WORKSPACE_DEFAULTS.git],
    userConfig.git as Partial<NxReleaseConfig['git']>
  );
  const rootVersionConfig: NxReleaseConfig['version'] = deepMergeDefaults(
    [
      WORKSPACE_DEFAULTS.version,
      // Merge in the git defaults from the top level
      { git: rootGitConfig } as NxReleaseConfig['version'],
    ],
    userConfig.version as Partial<NxReleaseConfig['version']>
  );

  if (userConfig.changelog?.workspaceChangelog) {
    userConfig.changelog.workspaceChangelog = normalizeTrueToEmptyObject(
      userConfig.changelog.workspaceChangelog
    );
  }
  if (userConfig.changelog?.projectChangelogs) {
    userConfig.changelog.projectChangelogs = normalizeTrueToEmptyObject(
      userConfig.changelog.projectChangelogs
    );
  }

  const rootChangelogConfig: NxReleaseConfig['changelog'] = deepMergeDefaults(
    [
      WORKSPACE_DEFAULTS.changelog,
      // Merge in the git defaults from the top level
      { git: rootGitConfig } as NxReleaseConfig['changelog'],
    ],
    normalizeTrueToEmptyObject(userConfig.changelog) as Partial<
      NxReleaseConfig['changelog']
    >
  );

  // git configuration is not supported at the group level, only the root/command level
  const rootVersionWithoutGit = { ...rootVersionConfig };
  delete rootVersionWithoutGit.git;

  const groups: NxReleaseConfig['groups'] =
    userConfig.groups && Object.keys(userConfig.groups).length
      ? ensureProjectsConfigIsArray(userConfig.groups)
      : /**
         * No user specified release groups, so we treat all projects (or any any user-defined subset via the top level "projects" property)
         * as being in one release group together in which the projects are released in lock step.
         */
        {
          [IMPLICIT_DEFAULT_RELEASE_GROUP]: {
            projectsRelationship: GROUP_DEFAULTS.projectsRelationship,
            projects: userConfig.projects
              ? // user-defined top level "projects" config takes priority if set
                findMatchingProjects(
                  ensureArray(userConfig.projects),
                  projectGraph.nodes
                )
              : // default to all library projects in the workspace
                findMatchingProjects(['*'], projectGraph.nodes).filter(
                  (project) => projectGraph.nodes[project].type === 'lib'
                ),
            /**
             * For properties which are overriding config at the root, we use the root level config as the
             * default values to merge with so that the group that matches a specific project will always
             * be the valid source of truth for that type of config.
             */
            version: deepMergeDefaults(
              [GROUP_DEFAULTS.version],
              rootVersionWithoutGit
            ),
            // If the user has set something custom for releaseTagPattern at the top level, respect it for the implicit default group
            releaseTagPattern:
              userConfig.releaseTagPattern || GROUP_DEFAULTS.releaseTagPattern,
            // Directly inherit the root level config for projectChangelogs, if set
            changelog: rootChangelogConfig.projectChangelogs || false,
          },
        };

  /**
   * Resolve all the project names into their release groups, and check
   * that individual projects are not found in multiple groups.
   */
  const releaseGroups: NxReleaseConfig['groups'] = {};
  const alreadyMatchedProjects = new Set<string>();

  for (const [releaseGroupName, releaseGroup] of Object.entries(groups)) {
    // Ensure that the config for the release group can resolve at least one project
    const matchingProjects = findMatchingProjects(
      releaseGroup.projects,
      projectGraph.nodes
    );
    if (!matchingProjects.length) {
      return {
        error: {
          code: 'RELEASE_GROUP_MATCHES_NO_PROJECTS',
          data: {
            releaseGroupName: releaseGroupName,
          },
        },
        nxReleaseConfig: null,
      };
    }

    // Ensure all matching projects have the relevant target available, if applicable
    if (requiredTargetName) {
      const error = ensureProjectsHaveTarget(
        matchingProjects,
        projectGraph,
        requiredTargetName
      );
      if (error) {
        return {
          error,
          nxReleaseConfig: null,
        };
      }
    }

    // If provided, ensure release tag pattern is valid
    if (releaseGroup.releaseTagPattern) {
      const error = ensureReleaseGroupReleaseTagPatternIsValid(
        releaseGroup.releaseTagPattern,
        releaseGroupName
      );
      if (error) {
        return {
          error,
          nxReleaseConfig: null,
        };
      }
    }

    for (const project of matchingProjects) {
      if (alreadyMatchedProjects.has(project)) {
        return {
          error: {
            code: 'PROJECT_MATCHES_MULTIPLE_GROUPS',
            data: {
              project,
            },
          },
          nxReleaseConfig: null,
        };
      }
      alreadyMatchedProjects.add(project);
    }

    // First apply any group level defaults, then apply actual root level config (if applicable), then group level config
    const groupChangelogDefaults: Array<
      NxReleaseConfig['groups']['string']['changelog']
    > = [GROUP_DEFAULTS.changelog];
    if (rootChangelogConfig.projectChangelogs) {
      groupChangelogDefaults.push(rootChangelogConfig.projectChangelogs);
    }

    const projectsRelationship =
      releaseGroup.projectsRelationship || GROUP_DEFAULTS.projectsRelationship;

    if (releaseGroup.changelog) {
      releaseGroup.changelog = normalizeTrueToEmptyObject(
        releaseGroup.changelog
      ) as NxReleaseConfig['groups']['string']['changelog'];
    }

    const groupDefaults: NxReleaseConfig['groups']['string'] = {
      projectsRelationship,
      projects: matchingProjects,
      version: deepMergeDefaults(
        // First apply any group level defaults, then apply actual root level config, then group level config
        [GROUP_DEFAULTS.version, rootVersionWithoutGit],
        releaseGroup.version
      ),
      // If the user has set any changelog config at all, including at the root level, then use one set of defaults, otherwise default to false for the whole feature
      changelog:
        releaseGroup.changelog || rootChangelogConfig.projectChangelogs
          ? deepMergeDefaults<NxReleaseConfig['groups']['string']['changelog']>(
              groupChangelogDefaults,
              releaseGroup.changelog || {}
            )
          : false,

      releaseTagPattern:
        releaseGroup.releaseTagPattern ||
        // The appropriate group default releaseTagPattern is dependent upon the projectRelationships
        (projectsRelationship === 'independent'
          ? defaultIndependentReleaseTagPattern
          : userConfig.releaseTagPattern || defaultFixedReleaseTagPattern),
    };

    releaseGroups[releaseGroupName] = deepMergeDefaults([groupDefaults], {
      ...releaseGroup,
      // Ensure that the resolved project names take priority over the original user config (which could have contained unresolved globs etc)
      projects: matchingProjects,
    });
  }

  return {
    error: null,
    nxReleaseConfig: {
      projectsRelationship: WORKSPACE_DEFAULTS.projectsRelationship,
      releaseTagPattern: WORKSPACE_DEFAULTS.releaseTagPattern,
      git: rootGitConfig,
      version: rootVersionConfig,
      changelog: rootChangelogConfig,
      groups: releaseGroups,
    },
  };
}

/**
 * In some cases it is much cleaner and more intuitive for the user to be able to
 * specify `true` in their config when they want to use the default config for a
 * particular property, rather than having to specify an empty object.
 */
function normalizeTrueToEmptyObject<T>(value: T | boolean): T | {} {
  return value === true ? {} : value;
}

export async function handleNxReleaseConfigError(
  error: CreateNxReleaseConfigError
): Promise<never> {
  switch (error.code) {
    case 'PROJECTS_AND_GROUPS_DEFINED':
      {
        const nxJsonMessage = await resolveNxJsonConfigErrorMessage([
          'release',
          'projects',
        ]);
        output.error({
          title: `"projects" is not valid when explicitly defining release groups, and everything should be expressed within "groups" in that case. If you are using "groups" then you should remove the "projects" property`,
          bodyLines: [nxJsonMessage],
        });
      }
      break;
    case 'RELEASE_GROUP_MATCHES_NO_PROJECTS':
      {
        const nxJsonMessage = await resolveNxJsonConfigErrorMessage([
          'release',
          'groups',
        ]);
        output.error({
          title: `Release group "${error.data.releaseGroupName}" matches no projects. Please ensure all release groups match at least one project:`,
          bodyLines: [nxJsonMessage],
        });
      }
      break;
    case 'PROJECT_MATCHES_MULTIPLE_GROUPS':
      {
        const nxJsonMessage = await resolveNxJsonConfigErrorMessage([
          'release',
          'groups',
        ]);
        output.error({
          title: `Project "${error.data.project}" matches multiple release groups. Please ensure all projects are part of only one release group:`,
          bodyLines: [nxJsonMessage],
        });
      }
      break;
    case 'PROJECTS_MISSING_TARGET':
      {
        output.error({
          title: `Based on your config, the following projects were matched for release but do not have a "${error.data.targetName}" target specified. Please ensure you have an appropriate plugin such as @nx/js installed, or have configured the target manually, or exclude the projects using release groups config in nx.json:`,
          bodyLines: Array.from(error.data.projects).map((name) => `- ${name}`),
        });
      }
      break;
    case 'RELEASE_GROUP_RELEASE_TAG_PATTERN_VERSION_PLACEHOLDER_MISSING_OR_EXCESSIVE':
      {
        const nxJsonMessage = await resolveNxJsonConfigErrorMessage([
          'release',
          'groups',
          error.data.releaseGroupName as string,
          'releaseTagPattern',
        ]);
        output.error({
          title: `Release group "${error.data.releaseGroupName}" has an invalid releaseTagPattern. Please ensure the pattern contains exactly one instance of the "{version}" placeholder`,
          bodyLines: [nxJsonMessage],
        });
      }
      break;
    default:
      throw new Error(`Unhandled error code: ${error.code}`);
  }

  process.exit(1);
}

function ensureReleaseGroupReleaseTagPatternIsValid(
  releaseTagPattern: string,
  releaseGroupName: string
): null | CreateNxReleaseConfigError {
  // ensure that any provided releaseTagPattern contains exactly one instance of {version}
  return releaseTagPattern.split('{version}').length === 2
    ? null
    : {
        code: 'RELEASE_GROUP_RELEASE_TAG_PATTERN_VERSION_PLACEHOLDER_MISSING_OR_EXCESSIVE',
        data: {
          releaseGroupName,
        },
      };
}

function ensureProjectsConfigIsArray(
  groups: NxJsonConfiguration['release']['groups']
): NxReleaseConfig['groups'] {
  const result: NxJsonConfiguration['release']['groups'] = {};
  for (const [groupName, groupConfig] of Object.entries(groups)) {
    result[groupName] = {
      ...groupConfig,
      projects: ensureArray(groupConfig.projects),
    };
  }
  return result as NxReleaseConfig['groups'];
}

function ensureArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function ensureProjectsHaveTarget(
  projects: string[],
  projectGraph: ProjectGraph,
  requiredTargetName: string
): null | CreateNxReleaseConfigError {
  const missingTargetProjects = projects.filter(
    (project) =>
      !projectHasTarget(projectGraph.nodes[project], requiredTargetName)
  );
  if (missingTargetProjects.length) {
    return {
      code: 'PROJECTS_MISSING_TARGET',
      data: {
        targetName: requiredTargetName,
        projects: missingTargetProjects,
      },
    };
  }
  return null;
}

function isObject(value: any): value is Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value);
}

// Helper function to merge two config objects
function mergeConfig<T>(
  objA: DeepRequired<T>,
  objB: Partial<T>
): DeepRequired<T> {
  const merged: any = { ...objA };

  for (const key in objB) {
    if (objB.hasOwnProperty(key)) {
      // If objB[key] is explicitly set to false, null or 0, respect that value
      if (objB[key] === false || objB[key] === null || objB[key] === 0) {
        merged[key] = objB[key];
      }
      // If both objA[key] and objB[key] are objects, recursively merge them
      else if (isObject(merged[key]) && isObject(objB[key])) {
        merged[key] = mergeConfig(merged[key], objB[key]);
      }
      // If objB[key] is defined, use it (this will overwrite any existing value in merged[key])
      else if (objB[key] !== undefined) {
        merged[key] = objB[key];
      }
    }
  }

  return merged as DeepRequired<T>;
}

/**
 * This function takes in a strictly typed collection of all possible default values in a particular section of config,
 * and an optional set of partial user config, and returns a single, deeply merged config object, where the user
 * config takes priority over the defaults in all cases (only an `undefined` value in the user config will be
 * overwritten by the defaults, all other falsey values from the user will be respected).
 */
function deepMergeDefaults<T>(
  defaultConfigs: DeepRequired<T>[],
  userConfig?: Partial<T>
): DeepRequired<T> {
  let result: any;

  // First merge defaultConfigs sequentially (meaning later defaults will override earlier ones)
  for (const defaultConfig of defaultConfigs) {
    if (!result) {
      result = defaultConfig;
      continue;
    }
    result = mergeConfig(result, defaultConfig as Partial<T>);
  }

  // Finally, merge the userConfig
  if (userConfig) {
    result = mergeConfig(result, userConfig);
  }

  return result as DeepRequired<T>;
}
