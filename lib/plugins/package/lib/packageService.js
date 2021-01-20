'use strict';

const path = require('path');
const globby = require('globby');
const _ = require('lodash');
const micromatch = require('micromatch');
const fs = require('fs');
const program = require('child_process');
const buildQueue = require('./buildQueue');

const builtLibraries = new Map(); // maps source path to bin path

module.exports = {
  defaultExcludes: [
    '.git/**',
    '.gitignore',
    '.DS_Store',
    'npm-debug.log',
    'yarn-*.log',
    '.serverless/**',
    '.serverless_plugins/**',
  ],

  getIncludes(include) {
    const packageIncludes = this.serverless.service.package.include || [];
    return _.union(packageIncludes, include);
  },

  getRuntime(runtime) {
    const defaultRuntime = 'nodejs12.x';
    return runtime || this.serverless.service.provider.runtime || defaultRuntime;
  },

  getExcludes(exclude, excludeLayers) {
    const configFilePath = this.serverless.configurationPath;
    const packageExcludes = this.serverless.service.package.exclude || [];
    // add local service plugins Path
    const pluginsLocalPath = this.serverless.pluginManager.parsePluginsObject(
      this.serverless.service.plugins
    ).localPath;
    const localPathExcludes = pluginsLocalPath ? [pluginsLocalPath] : [];
    // add layer paths
    const layerExcludes = excludeLayers
      ? this.serverless.service
          .getAllLayers()
          .map((layer) => `${this.serverless.service.getLayer(layer).path}/**`)
      : [];
    // add defaults for exclude

    const serverlessConfigFileExclude = configFilePath ? [path.basename(configFilePath)] : [];

    const serverlessConfigFile = this.serverless.pluginManager.serverlessConfigFile;
    const envFilesExclude = serverlessConfigFile && serverlessConfigFile.useDotenv ? ['.env*'] : [];

    return _.union(
      this.defaultExcludes,
      serverlessConfigFileExclude,
      localPathExcludes,
      packageExcludes,
      layerExcludes,
      envFilesExclude,
      exclude
    );
  },

  async packageService() {
    this.serverless.cli.log('Packaging service...');
    var serverlessCli = this.serverless.cli;
    
    let shouldPackageService = false;
    builtLibraries.clear();
    const allFunctions = this.serverless.service.getAllFunctions();
    var count = 0;
    let packagePromises = allFunctions.map(async (functionName) => {
      const functionObject = this.serverless.service.getFunction(functionName);
      if (functionObject.image) return;
      functionObject.package = functionObject.package || {};
      if (functionObject.package.disable) {
        serverlessCli.log(`Packaging disabled for function: "${functionName}"`);
        return;
      }
      if (functionObject.package.artifact) return;
      if (functionObject.package.individually || this.serverless.service.package.individually) {
        await this.buildFunction(functionName);
        await this.packageFunction(functionName);
        return;
      }
      shouldPackageService = true;
    });
    const allLayers = this.serverless.service.getAllLayers();
    packagePromises = packagePromises.concat(
      allLayers.map(async (layerName) => {
        const layerObject = this.serverless.service.getLayer(layerName);
        layerObject.package = layerObject.package || {};
        if (layerObject.package.artifact) return;
        await this.packageLayer(layerName);
      })
    );

    await Promise.all(packagePromises);
    if (shouldPackageService && !this.serverless.service.package.artifact) await this.packageAll();
  },

  packageAll() {
    const zipFileName = `${this.serverless.service.service}.zip`;

    return this.resolveFilePathsAll().then((filePaths) =>
      this.zipFiles(filePaths, zipFileName).then((filePath) => {
        // only set the default artifact for backward-compatibility
        // when no explicit artifact is defined
        if (!this.serverless.service.package.artifact) {
          this.serverless.service.package.artifact = filePath;
          this.serverless.service.artifact = filePath;
        }
        return filePath;
      })
    );
  },

  async packageFunction(functionName) {
    const functionObject = this.serverless.service.getFunction(functionName);
    if (functionObject.image) return null;

    const funcPackageConfig = functionObject.package || {};

    // use the artifact in function config if provided
    if (funcPackageConfig.artifact) {
      const filePath = path.resolve(this.serverless.config.servicePath, funcPackageConfig.artifact);
      functionObject.package.artifact = filePath;
      return filePath;
    }

    // use the artifact in service config if provided
    // and if the function is not set to be packaged individually
    if (this.serverless.service.package.artifact && !funcPackageConfig.individually) {
      const filePath = path.resolve(
        this.serverless.config.servicePath,
        this.serverless.service.package.artifact
      );
      funcPackageConfig.artifact = filePath;

      return filePath;
    }

    const zipFileName = `${functionName}.zip`;
    const filePaths = await this.resolveFilePathsFunction(functionName);
    const artifactPath = await this.zipFiles(filePaths, zipFileName);
    funcPackageConfig.artifact = artifactPath;
    return artifactPath;
  },

  packageLayer(layerName) {
    const layerObject = this.serverless.service.getLayer(layerName);

    const zipFileName = `${layerName}.zip`;

    return this.resolveFilePathsLayer(layerName)
      .then((filePaths) => filePaths.map((f) => path.resolve(path.join(layerObject.path, f))))
      .then((filePaths) =>
        this.zipFiles(filePaths, zipFileName, path.resolve(layerObject.path)).then(
          (artifactPath) => {
            layerObject.package = {
              artifact: artifactPath,
            };
            return artifactPath;
          }
        )
      );
  },

  async resolveFilePathsAll() {
    return this.resolveFilePathsFromPatterns(
      await this.excludeDevDependencies({
        exclude: this.getExcludes([], true),
        include: this.getIncludes(),
      })
    );
  },

  async resolveFilePathsInFolder(folder) {
    var params = {
      exclude: [],
      include: [path.join(folder, "**", "*")],
    };
    var files = await this.resolveFilePathsFromPatterns(
      params, folder
    );
    return files.map(f => path.join(folder, f));
  },

  async resolveFilePathsFunction(functionName) {
    const functionObject = this.serverless.service.getFunction(functionName);
    const funcPackageConfig = functionObject.package || {};

    return this.resolveFilePathsFromPatterns(
      await this.excludeDevDependencies({
        exclude: this.getExcludes(funcPackageConfig.exclude, true),
        include: this.getIncludes(funcPackageConfig.include),
      })
    );
  },

  async buildFunction(functionName) {
    const functionObject = this.serverless.service.getFunction(functionName);
    const runtime = this.getRuntime(functionObject.runtime);
    this.serverless.cli.debugLog(`Ready function ${functionName} for ${runtime}`);
    if (runtime.startsWith('dotnet')) {
      return await this.buildDotNetFunction(functionObject);
    }
  },

  async buildDotNetFunction(functionObject) {
    var serverlessCli = this.serverless.cli;
    // compile all .csproj files in the includes glob
    if (!functionObject.package || !functionObject.package.include) {
      throw `You must specify the .Net project file (e.g. .csproj) in the function|package|include section of serverless.yml for function ${functionObject.name}`;
    }
    const includes = this.getIncludes(functionObject.package.include);
    const functionName = functionObject.name;
    const self = this;
    for (var srcPath of includes) {
      if (srcPath.endsWith('.csproj')) {
        // this is a dotnet project to be built
        // we don't want to build the same project twice so check for duplicates
        if (builtLibraries.has(srcPath)) {
          // duplicate found - wait for it to build and use the same artifact
          functionObject.package.artifact = await builtLibraries.get(srcPath);
          continue;
        }
        // build the project
        var completionResolver;
        let completionPromise = new Promise(resolve => completionResolver = resolve);
        // let following iterations know that we're building
        builtLibraries.set(srcPath, completionPromise);

        await buildQueue.sequentialExecute(async () => {
          // use sequential execute so as not to stomp on any builds of shared libraries
          await new Promise(function (resolve, reject) {
            try {
              // do the actual build with a shell script
              self.serverless.cli.debugLog(`building ${srcPath}`);
              let outputPath = path.join(
                self.serverless.config.servicePath,
                '.bin',
                functionName
              );
              self.mkDirByPathSync(outputPath);
              const configuration = 'Release';
              program.exec(
                `dotnet publish ${srcPath} -c ${configuration} -o ${outputPath} --nologo /p:GenerateRuntimeConfigurationFiles=true`,
                function (error, stdout, stderr) {
                  serverlessCli.log(stdout);

                  if (error) {
                    serverlessCli.log('An error occured while restoring packages');
                    serverlessCli.log(stderr);
                    return reject(error);
                  }
                  return resolve(outputPath);
                }
              );              
            } catch (err) {
              return reject(err);
            }
          });
          // build the artifact
          var folder = path.join('.bin', functionName);
          var files = await this.resolveFilePathsInFolder(folder);
          let artifact = await this.zipFiles(files, `${functionName}.zip`, folder);
          functionObject.package.artifact = artifact;
          // let duplicate builds know that we're done and give them the artifact
          completionResolver(artifact);
        });
      }
    }
  },

  mkDirByPathSync(targetDir, { isRelativeToScript = false } = {}) {
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    return targetDir.split(sep).reduce((parentDir, childDir) => {
      const curDir = path.resolve(baseDir, parentDir, childDir);
      try {
        fs.mkdirSync(curDir);
      } catch (err) {
        if (err.code === 'EEXIST') {
          // curDir already exists!
          return curDir;
        }

        // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
        if (err.code === 'ENOENT') {
          // Throw the original parentDir error on curDir `ENOENT` failure.
          throw new Error(`EACCES: permission denied, mkdir '${parentDir}'`);
        }

        const caughtErr = ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1;
        if (!caughtErr || (caughtErr && curDir === path.resolve(targetDir))) {
          throw err; // Throw if it's just the last created dir.
        }
      }

      return curDir;
    }, initDir);
  },

  async resolveFilePathsLayer(layerName) {
    const layerObject = this.serverless.service.getLayer(layerName);
    const layerPackageConfig = layerObject.package || {};
    
    return this.resolveFilePathsFromPatterns(
      await this.excludeDevDependencies({
        exclude: this.getExcludes(layerPackageConfig.exclude, false),
        include: this.getIncludes(layerPackageConfig.include),
      }),
      layerObject.path
    );
  },

  resolveFilePathsFromPatterns(params, prefix) {
    const patterns = [];
    params = params || {};
    params.include = params.include || [];
    params.exclude = params.exclude || [];

    params.exclude.forEach((pattern) => {
      if (pattern.charAt(0) !== '!') {
        patterns.push(`!${pattern}`);
      } else {
        patterns.push(pattern.substring(1));
      }
    });

    // push the include globs to the end of the array
    // (files and folders will be re-added again even if they were excluded beforehand)
    params.include.forEach((pattern) => {
      patterns.push(pattern);
    });

    var rootPath = path.join(this.serverless.config.servicePath, prefix || '');
    // NOTE: please keep this order of concatenating the include params
    // rather than doing it the other way round!
    // see https://github.com/serverless/serverless/pull/5825 for more information
    return globby(['**'].concat(params.include), {
      cwd: rootPath,
      dot: true,
      silent: true,
      follow: true,
      nodir: true,
      expandDirectories: false,
    }).then((allFilePaths) => {
      const filePathStates = allFilePaths.reduce((p, c) => Object.assign(p, { [c]: true }), {});
      patterns
        // micromatch only does / style path delimiters, so convert them if on windows
        .map((p) => {
          return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
        })
        .forEach((p) => {
          const exclude = p.startsWith('!');
          const pattern = exclude ? p.slice(1) : p;
          micromatch(allFilePaths, [pattern], { dot: true }).forEach((key) => {
            filePathStates[key] = !exclude;
          });
        });
      const filePaths = Object.entries(filePathStates)
        .filter((r) => r[1] === true)
        .map((r) => r[0]);
      if (filePaths.length !== 0) return filePaths;
      throw new this.serverless.classes.Error('No file matches include / exclude patterns');
    });
  },
};
