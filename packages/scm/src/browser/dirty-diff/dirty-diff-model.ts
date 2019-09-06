import { Autowired, Injectable, Optional } from '@ali/common-di';
import { Uri, URI } from '@ali/ide-core-common/lib/uri';
import { Emitter, Event, sortedDiff } from '@ali/ide-core-common';
import { IDisposable, dispose, Disposable, DisposableStore, toDisposable } from '@ali/ide-core-common/lib/disposable';
import { first } from '@ali/ide-core-common/lib/async';
import { ThrottledDelayer } from '@ali/ide-core-common';
import { IChange } from '@ali/ide-editor';
import { ISplice } from '@ali/ide-core-common/lib/sequence';
import { IDocumentModelManager } from '@ali/ide-doc-model';

import { SCMService, ISCMRepository } from '../../common';
import { compareChanges, getModifiedEndLineNumber } from './dirty-diff-util';

@Injectable()
export class DirtyDiffModel extends Disposable {
  private _originalModel: monaco.editor.ITextModel | null;
  get original(): monaco.editor.ITextModel | null { return this._originalModel; }
  get modified(): monaco.editor.ITextModel | null { return this._editorModel; }

  private diffDelayer: ThrottledDelayer<IChange[] | null> | null;
  private _originalURIPromise?: Promise<Uri | null>;
  private repositoryDisposables = new Set<IDisposable>();
  private readonly originalModelDisposables: DisposableStore;

  private _onDidChange = new Emitter<ISplice<IChange>[]>();
  readonly onDidChange: Event<ISplice<IChange>[]> = this._onDidChange.event;

  private _changes: IChange[] = [];
  get changes(): IChange[] {
    return this._changes;
  }

  private _editorModel: monaco.editor.ITextModel | null;

  @Autowired(SCMService)
  scmService: SCMService;

  @Autowired(IDocumentModelManager)
  documentModelManager: IDocumentModelManager;

  private get editorWorkerService(): monaco.commons.IEditorWorkerService {
    return monaco.services.StaticServices.editorWorkerService.get();
  }

  constructor(
    @Optional() editorModel: monaco.editor.ITextModel,
  ) {
    super();
    this._editorModel = editorModel;
    this.diffDelayer = new ThrottledDelayer<IChange[]>(200);

    this.addDispose(editorModel.onDidChangeContent(() => this.triggerDiff()));
    this.addDispose(this.scmService.onDidAddRepository(this.onDidAddRepository, this));
    this.scmService.repositories.forEach((r) => this.onDidAddRepository(r));

    this.triggerDiff();

    this.originalModelDisposables = new DisposableStore();
    this.addDispose(this.originalModelDisposables);
  }

  private onDidAddRepository(repository: ISCMRepository): void {
    const disposables = new DisposableStore();

    this.repositoryDisposables.add(disposables);
    disposables.add(toDisposable(() => this.repositoryDisposables.delete(disposables)));

    const onDidChange = Event.any(repository.provider.onDidChange, repository.provider.onDidChangeResources);
    disposables.add(onDidChange(this.triggerDiff, this));

    const onDidRemoveThis = Event.filter(this.scmService.onDidRemoveRepository, (r) => r === repository);
    disposables.add(onDidRemoveThis(() => dispose(disposables), null));

    this.triggerDiff();
  }

  private triggerDiff(): Promise<any> {
    if (!this.diffDelayer) {
      return Promise.resolve(null);
    }

    return this.diffDelayer
      .trigger(() => this.diff())
      .then((changes) => {
        if (!this._editorModel || this._editorModel.isDisposed() || !this._originalModel || this._originalModel.isDisposed()) {
          return; // disposed
        }

        if (!changes || this._originalModel.getValueLength() === 0) {
          changes = [];
        }

        const diff = sortedDiff(this._changes, changes, compareChanges);
        this._changes = changes;

        if (diff.length > 0) {
          this._onDidChange.fire(diff);
        }
      });
  }

  // 计算 diff
  private diff(): Promise<IChange[] | null> {
    return this.getOriginalURIPromise().then((originalURI) => {
      if (!this._editorModel || this._editorModel.isDisposed() || !originalURI) {
        return Promise.resolve([]); // disposed
      }

      // 复用 monaco 内部的 canComputeDiff 本质跟 canComputeDirtyDiff 实现一致
      if (!this.editorWorkerService.canComputeDiff(originalURI as monaco.Uri, this._editorModel.uri)) {
        return Promise.resolve([]); // Files too large
      }

      // 复用 monaco 内部的 computeDiff 跟 computeDirtyDiff 参数不一致
      // 主要是 shouldComputeCharChanges#false, shouldPostProcessCharChanges#false
      return this.editorWorkerService.computeDiff(originalURI as monaco.Uri, this._editorModel.uri, false)
        .then((ret) => ret && ret.changes);
    });
  }

  private getOriginalURIPromise(): Promise<Uri | null> {
    if (this._originalURIPromise) {
      return this._originalURIPromise;
    }

    this._originalURIPromise = this.getOriginalResource().then((originalUri) => {
      if (!this._editorModel) { // disposed
        return null;
      }

      if (!originalUri) {
        this._originalModel = null;
        return null;
      }

      if (this._originalModel && this._originalModel.uri.toString() === originalUri.toString()) {
        return originalUri;
      }

      return this.documentModelManager.createModelReference(new URI(originalUri.toString()))
        .then((docModelRef) => {
          if (!this._editorModel) { // disposed
            return null;
          }

          if (!docModelRef) {
            return null;
          }

          const textEditorModel = docModelRef.instance.toEditor();

          this._originalModel = textEditorModel;

          this.originalModelDisposables.clear();
          this.originalModelDisposables.add(docModelRef);
          this.originalModelDisposables.add(textEditorModel.onDidChangeContent(() => this.triggerDiff()));

          return originalUri;
        });
    });

    return this._originalURIPromise.finally(() => {
      this._originalURIPromise = undefined;
    });
  }

  private getOriginalResource(): Promise<Uri | null> {
    if (!this._editorModel) {
      return Promise.resolve(null);
    }

    const uri = this._editorModel.uri;
    return first(this.scmService.repositories.map((r) => () => r.provider.getOriginalResource(uri)));
  }

  // 查找下一个changes
  findNextClosestChange(lineNumber: number, inclusive = true): number {
    for (let i = 0; i < this.changes.length; i++) {
      const change = this.changes[i];

      if (inclusive) {
        if (getModifiedEndLineNumber(change) >= lineNumber) {
          return i;
        }
      } else {
        if (change.modifiedStartLineNumber > lineNumber) {
          return i;
        }
      }
    }

    return 0;
  }

  // 查找上一个changes
  findPreviousClosestChange(lineNumber: number, inclusive = true): number {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const change = this.changes[i];

      if (inclusive) {
        if (change.modifiedStartLineNumber <= lineNumber) {
          return i;
        }
      } else {
        if (getModifiedEndLineNumber(change) < lineNumber) {
          return i;
        }
      }
    }

    return this.changes.length - 1;
  }

  dispose(): void {
    super.dispose();

    this._editorModel = null;
    this._originalModel = null;

    if (this.diffDelayer) {
      this.diffDelayer.cancel();
      this.diffDelayer = null;
    }

    this.repositoryDisposables.forEach((d) => dispose(d));
    this.repositoryDisposables.clear();
  }
}
