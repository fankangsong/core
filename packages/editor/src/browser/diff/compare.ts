import { Injectable, Autowired } from '@ali/common-di';
import { ICompareService, CompareResult } from '../types';
import { URI, Domain, localize, Deferred, CommandService, EDITOR_COMMANDS, CommandContribution, CommandRegistry } from '@ali/ide-core-browser';
import { getIcon } from '@ali/ide-core-browser';
import { NextMenuContribution, IMenuRegistry, MenuId } from '@ali/ide-core-browser/lib/menu/next';

@Injectable()
export class CompareService implements ICompareService {

  public readonly comparing = new Map<string, Deferred<CompareResult>>();

  @Autowired(CommandService)
  private commandService: CommandService;

  compare(original: URI, modified: URI, name: string): Promise<CompareResult> {
    const compareUri = URI.from({
      scheme: 'diff',
      query: URI.stringifyQuery({
        name,
        original,
        modified,
        comparing: true,
      }),
    });
    if (!this.comparing.has(compareUri.toString())) {
      const deferred = new Deferred<CompareResult>();
      this.comparing.set(compareUri.toString(), deferred);
      deferred.promise.then(() => {
        this.comparing.delete(compareUri.toString());
        this.commandService.executeCommand(EDITOR_COMMANDS.CLOSE_ALL.id, compareUri);
      });
    }
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, compareUri);
    return this.comparing.get(compareUri.toString())!.promise;
  }
}

@Domain(NextMenuContribution, CommandContribution)
export class CompareEditorContribution implements NextMenuContribution, CommandContribution {

  @Autowired(ICompareService)
  compareService: CompareService;

  registerNextMenus(menu: IMenuRegistry) {
    menu.registerMenuItems(MenuId.EditorTitle, [
      {
        command: {
          id: 'editor.diff.accept',
          label: localize('editor.action.accept'),
        },
        iconClass: getIcon('check'),
        group: 'navigation',
        when: 'isInDiffEditor && diffResource =~ /%26comparing%3Dtrue$/',
      },
    ]);
    menu.registerMenuItems(MenuId.EditorTitle, [
      {
        command: {
          id: 'editor.diff.revert',
          label: localize('editor.action.revert'),
        },
        iconClass: getIcon('rollback'),
        group: 'navigation',
        when: 'isInDiffEditor && diffResource =~ /%26comparing%3Dtrue$/',
      },
    ]);
  }

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand({id: 'editor.diff.accept'}, {
      execute: (resource) => {
        if (resource && this.compareService.comparing.has(resource.uri.toString())) {
          this.compareService.comparing.get(resource.uri.toString())!.resolve(CompareResult.accept);
        }
      },
    });
    commands.registerCommand({id: 'editor.diff.revert'}, {
      execute: (resource) => {
        if (resource && this.compareService.comparing.has(resource.uri.toString())) {
          this.compareService.comparing.get(resource.uri.toString())!.resolve(CompareResult.revert);
        }
      },
    });
  }

}
