import * as ts from 'typescript'; // Imported for types alone

import { LinkedList } from './LinkedList';
import { VueProgram } from './VueProgram';
import { ResolveModuleName, ResolveTypeReferenceDirective } from './resolution';
import { VueOptions } from './types/vue-options';

interface DirectoryWatchDelaySlot {
  events: { fileName: string }[];
  callback: ts.DirectoryWatcherCallback;
}

interface FileWatchDelaySlot {
  events: { fileName: string; eventKind: ts.FileWatcherEventKind }[];
  callback: ts.FileWatcherCallback;
}

export class CompilerHost
  implements
    ts.WatchCompilerHostOfConfigFile<
      ts.EmitAndSemanticDiagnosticsBuilderProgram
    > {
  private program?: ts.WatchOfConfigFile<
    ts.EmitAndSemanticDiagnosticsBuilderProgram
  >;

  public getProgram(): ts.Program {
    if (!this.program) {
      throw new Error('Program is not created yet.');
    }

    return this.program.getProgram().getProgram();
  }

  public getAllKnownFiles() {
    return this.knownFiles;
  }

  public configFileName: string;
  public optionsToExtend: ts.CompilerOptions;

  // intercept all watch events and collect them until we get notification to start compilation
  private directoryWatchers = new LinkedList<DirectoryWatchDelaySlot>();
  private fileWatchers = new LinkedList<FileWatchDelaySlot>();

  private knownFiles = new Set<string>();

  private gatheredDiagnostic: ts.Diagnostic[] = [];
  private afterCompile = () => {
    /* do nothing */
  };

  private readonly tsHost: ts.WatchCompilerHostOfConfigFile<
    ts.EmitAndSemanticDiagnosticsBuilderProgram
  >;
  protected lastProcessing?: Promise<ts.Diagnostic[]>;

  private compilationStarted = false;

  public resolveModuleNames:
    | ((
        moduleNames: string[],
        containingFile: string,
        reusedNames?: string[] | undefined,
        redirectedReference?: ts.ResolvedProjectReference | undefined
      ) => (ts.ResolvedModule | undefined)[])
    | undefined;
  public resolveTypeReferenceDirectives:
    | ((
        typeReferenceDirectiveNames: string[],
        containingFile: string,
        redirectedReference?: ts.ResolvedProjectReference | undefined
      ) => (ts.ResolvedTypeReferenceDirective | undefined)[])
    | undefined;

  constructor(
    private typescript: typeof ts,
    private vueOptions: VueOptions,
    programConfigFile: string,
    compilerOptions: ts.CompilerOptions,
    checkSyntacticErrors: boolean,
    userResolveModuleName?: ResolveModuleName,
    userResolveTypeReferenceDirective?: ResolveTypeReferenceDirective
  ) {
    this.tsHost = typescript.createWatchCompilerHost(
      programConfigFile,
      compilerOptions,
      typescript.sys,
      typescript.createEmitAndSemanticDiagnosticsBuilderProgram,
      (diag: ts.Diagnostic) => {
        if (
          !checkSyntacticErrors &&
          diag.code >= 1000 &&
          diag.code < 2000 &&
          diag.file // if diag.file is undefined, this is not a syntactic error, but a global error that should be emitted
        ) {
          return;
        }
        this.gatheredDiagnostic.push(diag);
      },
      () => {
        // do nothing
      }
    );

    this.configFileName = this.tsHost.configFileName;
    this.optionsToExtend = this.tsHost.optionsToExtend || {};

    if (userResolveModuleName) {
      this.resolveModuleNames = (
        moduleNames: string[],
        containingFile: string
      ) => {
        return moduleNames.map(moduleName => {
          return userResolveModuleName(
            this.typescript,
            moduleName,
            containingFile,
            this.optionsToExtend,
            this
          ).resolvedModule;
        });
      };
    }

    if (userResolveTypeReferenceDirective) {
      this.resolveTypeReferenceDirectives = (
        typeDirectiveNames: string[],
        containingFile: string
      ) => {
        return typeDirectiveNames.map(typeDirectiveName => {
          return userResolveTypeReferenceDirective(
            this.typescript,
            typeDirectiveName,
            containingFile,
            this.optionsToExtend,
            this
          ).resolvedTypeReferenceDirective;
        });
      };
    }
  }

  public async processChanges(): Promise<{
    results: ts.Diagnostic[];
    updatedFiles: string[];
    removedFiles: string[];
  }> {
    if (!this.lastProcessing) {
      const initialCompile = new Promise<ts.Diagnostic[]>(resolve => {
        this.afterCompile = () => {
          resolve(this.gatheredDiagnostic);
          this.afterCompile = () => {
            /* do nothing */
          };
          this.compilationStarted = false;
        };
      });
      this.lastProcessing = initialCompile;
      this.program = this.typescript.createWatchProgram(this);
      const errors = await initialCompile;
      return {
        results: errors,
        updatedFiles: Array.from(this.knownFiles),
        removedFiles: []
      };
    }

    // since we do not have a way to pass cancellation token to typescript,
    // we just wait until previous compilation finishes.
    await this.lastProcessing;

    const previousDiagnostic = this.gatheredDiagnostic;
    this.gatheredDiagnostic = [];
    const resultPromise = new Promise<ts.Diagnostic[]>(resolve => {
      this.afterCompile = () => {
        resolve(this.gatheredDiagnostic);
        this.afterCompile = () => {
          /* do nothing */
        };
        this.compilationStarted = false;
      };
    });
    this.lastProcessing = resultPromise;

    const files = [];

    this.directoryWatchers.forEach(item => {
      for (const e of item.events) {
        item.callback(e.fileName);
      }
      item.events.length = 0;
    });

    const updatedFiles: string[] = [];
    const removedFiles: string[] = [];
    this.fileWatchers.forEach(item => {
      for (const e of item.events) {
        item.callback(e.fileName, e.eventKind);
        files.push(e.fileName);
        if (
          e.eventKind === this.typescript.FileWatcherEventKind.Created ||
          e.eventKind === this.typescript.FileWatcherEventKind.Changed
        ) {
          updatedFiles.push(e.fileName);
        } else if (
          e.eventKind === this.typescript.FileWatcherEventKind.Deleted
        ) {
          removedFiles.push(e.fileName);
        }
      }
      item.events.length = 0;
    });

    // if the files are not relevant to typescript it may choose not to compile
    // in this case we need to trigger promise resolution from here
    if (!this.compilationStarted) {
      // keep diagnostic from previous run
      this.gatheredDiagnostic = previousDiagnostic;
      this.afterCompile();
      return {
        results: this.gatheredDiagnostic,
        updatedFiles: [],
        removedFiles: []
      };
    }

    const results = await resultPromise;
    return { results, updatedFiles, removedFiles };
  }

  public setTimeout(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (...args: any[]) => void,
    ms: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) {
    // There are 2 things we are hacking here:
    // 1. This method only called from watch program to wait until all files
    // are written to filesystem (for example, when doing 'save all')
    // We are intercepting all change notifications, and letting
    // them through only when webpack starts processing changes.
    // Therefore, at this point normally files are already all saved,
    // so we do not need to waste another 250 ms (hardcoded in TypeScript).
    // On the other hand there may be occasional glitch, when our incremental
    // compiler will receive the notification too late, and process it when
    // next compilation would start.
    // 2. It seems to be only reliable way to intercept a moment when TypeScript
    // actually starts compilation.
    //
    // Ideally we probably should not let TypeScript call all those watching
    // methods by itself, and instead forward changes from webpack.
    // Unfortunately, at the moment TypeScript incremental API is quite
    // immature (for example, minor changes in how you use it cause
    // dramatic compilation time increase), so we have to stick with these
    // hacks for now.
    this.compilationStarted = true;

    return (this.typescript.sys.setTimeout || setTimeout)(callback, 1, args);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public clearTimeout(timeoutId: any): void {
    (this.typescript.sys.clearTimeout || clearTimeout)(timeoutId);
  }

  public onWatchStatusChange(): void {
    // do nothing
  }

  public watchDirectory(
    path: string,
    callback: ts.DirectoryWatcherCallback,
    recursive?: boolean
  ): ts.FileWatcher {
    const slot: DirectoryWatchDelaySlot = { callback, events: [] };
    const node = this.directoryWatchers.add(slot);
    this.tsHost.watchDirectory(
      path,
      fileName => {
        slot.events.push({ fileName });
      },
      recursive
    );
    return {
      close: () => {
        node.detachSelf();
      }
    };
  }

  public watchFile(
    path: string,
    callback: ts.FileWatcherCallback,
    pollingInterval?: number
  ): ts.FileWatcher {
    const slot: FileWatchDelaySlot = { callback, events: [] };
    const node = this.fileWatchers.add(slot);
    this.knownFiles.add(path);
    this.tsHost.watchFile(
      path,
      (fileName, eventKind) => {
        if (eventKind === this.typescript.FileWatcherEventKind.Created) {
          this.knownFiles.add(fileName);
        } else if (eventKind === this.typescript.FileWatcherEventKind.Deleted) {
          this.knownFiles.delete(fileName);
        }
        slot.events.push({ fileName, eventKind });
      },
      pollingInterval
    );
    return {
      close: () => {
        node.detachSelf();
      }
    };
  }

  public fileExists(path: string): boolean {
    return this.tsHost.fileExists(path);
  }

  public readFile(path: string, encoding?: string) {
    const content = this.tsHost.readFile(path, encoding);

    // get typescript contents from Vue file
    if (content && VueProgram.isVue(path)) {
      const resolved = VueProgram.resolveScriptBlock(
        this.typescript,
        content,
        this.vueOptions.compiler
      );
      return resolved.content;
    }

    return content;
  }

  public directoryExists(path: string): boolean {
    return (
      (this.tsHost.directoryExists && this.tsHost.directoryExists(path)) ||
      false
    );
  }

  public getDirectories(path: string): string[] {
    return (
      (this.tsHost.getDirectories && this.tsHost.getDirectories(path)) || []
    );
  }

  public readDirectory(
    path: string,
    extensions?: ReadonlyArray<string>,
    exclude?: ReadonlyArray<string>,
    include?: ReadonlyArray<string>,
    depth?: number
  ): string[] {
    return this.typescript.sys.readDirectory(
      path,
      extensions,
      exclude,
      include,
      depth
    );
  }

  public createProgram = this.typescript
    .createEmitAndSemanticDiagnosticsBuilderProgram;

  public getCurrentDirectory(): string {
    return this.tsHost.getCurrentDirectory();
  }

  public getDefaultLibFileName(options: ts.CompilerOptions): string {
    return this.tsHost.getDefaultLibFileName(options);
  }

  public getEnvironmentVariable(name: string): string | undefined {
    return (
      this.tsHost.getEnvironmentVariable &&
      this.tsHost.getEnvironmentVariable(name)
    );
  }

  public getNewLine(): string {
    return this.tsHost.getNewLine();
  }

  public realpath(path: string): string {
    if (!this.tsHost.realpath) {
      throw new Error(
        'The realpath function is not supported by the CompilerHost.'
      );
    }

    return this.tsHost.realpath(path);
  }

  public trace(s: string): void {
    if (this.tsHost.trace) {
      this.tsHost.trace(s);
    }
  }

  public useCaseSensitiveFileNames(): boolean {
    return this.tsHost.useCaseSensitiveFileNames();
  }

  public onUnRecoverableConfigFileDiagnostic() {
    // do nothing
  }

  public afterProgramCreate(
    program: ts.EmitAndSemanticDiagnosticsBuilderProgram
  ): void {
    // all actual diagnostics happens here
    if (this.tsHost.afterProgramCreate) {
      this.tsHost.afterProgramCreate(program);
    }

    this.afterCompile();
  }

  // the functions below are use internally by typescript. we cannot use non-emitting version of incremental watching API
  // because it is
  // - much slower for some reason,
  // - writes files anyway (o_O)
  // - has different way of providing diagnostics. (with this version we can at least reliably get it from afterProgramCreate)
  public createDirectory(): void {
    // pretend everything was ok
  }

  public writeFile(): void {
    // pretend everything was ok
  }

  public onCachedDirectoryStructureHostCreate?(): void {
    // pretend everything was ok
  }
}
