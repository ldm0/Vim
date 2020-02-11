import * as vscode from 'vscode';

import { Position, PositionDiff, PositionDiffType } from './../common/motion/position';
import { Range } from './../common/motion/range';
import { configuration } from './../configuration/configuration';
import { Mode, isVisualMode } from './../mode/mode';
import { Register, RegisterMode } from './../register/register';
import { VimState } from './../state/vimState';
import { TextEditor } from './../textEditor';
import { BaseAction, RegisterAction } from './base';
import { CommandNumber } from './commands/actions';
import { TextObjectMovement } from './textobject';
import { reportLinesChanged, reportLinesYanked } from '../util/statusBarTextUtils';

export class BaseOperator extends BaseAction {
  constructor(multicursorIndex?: number) {
    super();
    this.multicursorIndex = multicursorIndex;
  }
  canBeRepeatedWithDot = true;
  isOperator = true;

  // All operators other than yank can change the document
  mightChangeDocument = true;

  /**
   * If this is being run in multi cursor mode, the index of the cursor
   * this operator is being applied to.
   */
  multicursorIndex: number | undefined = undefined;

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    if (this.doesRepeatedOperatorApply(vimState, keysPressed)) {
      return true;
    }
    if (!this.modes.includes(vimState.currentMode)) {
      return false;
    }
    if (!BaseAction.CompareKeypressSequence(this.keys, keysPressed)) {
      return false;
    }
    if (
      this.mustBeFirstKey &&
      vimState.recordedState.commandWithoutCountPrefix.length - keysPressed.length > 0
    ) {
      return false;
    }
    if (this instanceof BaseOperator && vimState.recordedState.operator) {
      return false;
    }

    return true;
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    if (!this.modes.includes(vimState.currentMode)) {
      return false;
    }
    if (!BaseAction.CompareKeypressSequence(this.keys.slice(0, keysPressed.length), keysPressed)) {
      return false;
    }
    if (
      this.mustBeFirstKey &&
      vimState.recordedState.commandWithoutCountPrefix.length - keysPressed.length > 0
    ) {
      return false;
    }
    if (this instanceof BaseOperator && vimState.recordedState.operator) {
      return false;
    }

    return true;
  }

  public doesRepeatedOperatorApply(vimState: VimState, keysPressed: string[]) {
    const nonCountActions = vimState.recordedState.actionsRun.filter(
      x => !(x instanceof CommandNumber)
    );
    const prevAction = nonCountActions[nonCountActions.length - 1];
    return (
      this.isOperator &&
      keysPressed.length === 1 &&
      prevAction &&
      this.modes.includes(vimState.currentMode) &&
      // The previous action is the same as the one we're testing
      prevAction.constructor === this.constructor &&
      // The key pressed is the same as the previous action's last key.
      BaseAction.CompareKeypressSequence(prevAction.keysPressed.slice(-1), keysPressed)
    );
  }

  /**
   * Run this operator on a range, returning the new location of the cursor.
   */
  run(vimState: VimState, start: Position, stop: Position): Promise<VimState> {
    throw new Error('You need to override this!');
  }

  runRepeat(vimState: VimState, position: Position, count: number): Promise<VimState> {
    vimState.currentRegisterMode = RegisterMode.LineWise;
    return this.run(
      vimState,
      position.getLineBegin(),
      position.getDownByCount(Math.max(0, count - 1)).getLineEnd()
    );
  }

  public highlightYankedRanges(vimState: VimState, ranges: vscode.Range[]) {
    if (!configuration.highlightedyank.enable) {
      return;
    }

    const yankDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: configuration.highlightedyank.color,
      color: configuration.highlightedyank.textColor,
    });

    vimState.editor.setDecorations(yankDecoration, ranges);
    setTimeout(() => yankDecoration.dispose(), configuration.highlightedyank.duration);
  }
}

@RegisterAction
export class DeleteOperator extends BaseOperator {
  public keys = ['d'];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];

  /**
   * Deletes from the position of start to 1 past the position of end.
   */
  public async delete(
    start: Position,
    end: Position,
    currentMode: Mode,
    registerMode: RegisterMode,
    vimState: VimState,
    yank = true
  ): Promise<Position> {
    if (registerMode === RegisterMode.LineWise) {
      start = start.getLineBegin();
      end = end.getLineEnd();
    }

    end = new Position(end.line, end.character + 1);

    const isOnLastLine = end.line === TextEditor.getLineCount() - 1;

    // Vim does this weird thing where it allows you to select and delete
    // the newline character, which it places 1 past the last character
    // in the line. Here we interpret a character position 1 past the end
    // as selecting the newline character. Don't allow this in visual block mode
    if (vimState.currentMode !== Mode.VisualBlock) {
      if (end.character === TextEditor.getLineAt(end).text.length + 1) {
        end = end.getDown(0);
      }
    }

    let text = vimState.editor.document.getText(new vscode.Range(start, end));

    // If we delete linewise to the final line of the document, we expect the line
    // to be removed. This is actually a special case because the newline
    // character we've selected to delete is the newline on the end of the document,
    // but we actually delete the newline on the second to last line.

    // Just writing about this is making me more confused. -_-

    // rebornix: johnfn's description about this corner case is perfectly correct. The only catch is
    // that we definitely don't want to put the EOL in the register. So here we run the `getText`
    // expression first and then update the start position.

    // Now rebornix is confused as well.
    if (isOnLastLine && start.line !== 0 && registerMode === RegisterMode.LineWise) {
      start = start.getPreviousLineBegin().getLineEnd();
    }

    if (registerMode === RegisterMode.LineWise) {
      // slice final newline in linewise mode - linewise put will add it back.
      text = text.endsWith('\r\n')
        ? text.slice(0, -2)
        : text.endsWith('\n')
        ? text.slice(0, -1)
        : text;
    }

    if (yank) {
      Register.put(text, vimState, this.multicursorIndex);
    }

    let diff = new PositionDiff();
    let resultingPosition: Position;

    if (currentMode === Mode.Visual) {
      resultingPosition = Position.EarlierOf(start, end);
    }

    if (start.character > TextEditor.getLineAt(start).text.length) {
      resultingPosition = start.getLeft();
      diff = new PositionDiff({ character: -1 });
    } else {
      resultingPosition = start;
    }

    if (registerMode === RegisterMode.LineWise) {
      resultingPosition = resultingPosition.obeyStartOfLine();
      diff = new PositionDiff({
        type: PositionDiffType.ObeyStartOfLine,
      });
    }

    vimState.recordedState.transformations.push({
      type: 'deleteRange',
      range: new Range(start, end),
      diff: diff,
    });

    return resultingPosition;
  }

  public async run(
    vimState: VimState,
    start: Position,
    end: Position,
    yank = true
  ): Promise<VimState> {
    let newPos = await this.delete(
      start,
      end,
      vimState.currentMode,
      vimState.effectiveRegisterMode,
      vimState,
      yank
    );

    await vimState.setCurrentMode(Mode.Normal);
    if (vimState.currentMode === Mode.Visual) {
      vimState.desiredColumn = newPos.character;
    }

    const numLinesDeleted = Math.abs(start.line - end.line) + 1;
    reportLinesChanged(-numLinesDeleted, vimState);

    return vimState;
  }
}

@RegisterAction
export class DeleteOperatorVisual extends BaseOperator {
  public keys = ['D'];
  public modes = [Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    // ensures linewise deletion when in visual mode
    // see special case in DeleteOperator.delete()
    vimState.currentRegisterMode = RegisterMode.LineWise;

    return new DeleteOperator(this.multicursorIndex).run(vimState, start, end);
  }
}

@RegisterAction
export class YankOperator extends BaseOperator {
  public keys = ['y'];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  canBeRepeatedWithDot = false;
  mightChangeDocument = false;

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    // Hack to make Surround with y (which takes a motion) work.

    if (vimState.surround) {
      vimState.surround.range = new Range(start, end);
      await vimState.setCurrentMode(Mode.SurroundInputMode);
      vimState.cursorStopPosition = start;
      vimState.cursorStartPosition = start;

      return vimState;
    }

    const originalMode = vimState.currentMode;

    if (end.isBefore(start)) {
      [start, end] = [end, start];
    }
    let extendedEnd = new Position(end.line, end.character + 1);

    if (vimState.currentRegisterMode === RegisterMode.LineWise) {
      start = start.getLineBegin();
      extendedEnd = extendedEnd.getLineEnd();
    }

    const range = new vscode.Range(start, extendedEnd);
    let text = TextEditor.getText(range);

    // If we selected the newline character, add it as well.
    if (
      vimState.currentMode === Mode.Visual &&
      extendedEnd.character === TextEditor.getLineAt(extendedEnd).text.length + 1
    ) {
      text = text + '\n';
    }

    this.highlightYankedRanges(vimState, [range]);

    Register.put(text, vimState, this.multicursorIndex);

    if (vimState.currentMode === Mode.Visual || vimState.currentMode === Mode.VisualLine) {
      vimState.historyTracker.addMark(start, '<');
      vimState.historyTracker.addMark(end, '>');
    }

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStartPosition = start;

    // Only change cursor position if we ran a text object movement
    let moveCursor = false;
    if (vimState.recordedState.actionsRun.length > 1) {
      if (vimState.recordedState.actionsRun[1] instanceof TextObjectMovement) {
        moveCursor = true;
      }
    }

    if (originalMode === Mode.Normal && !moveCursor) {
      vimState.cursors = vimState.cursorsInitialState;
    } else {
      vimState.cursorStopPosition = start;
    }

    const numLinesYanked = text.split('\n').length;
    reportLinesYanked(numLinesYanked, vimState);

    return vimState;
  }
}

@RegisterAction
export class ShiftYankOperatorVisual extends BaseOperator {
  public keys = ['Y'];
  public modes = [Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  mightChangeDocument = false;

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    vimState.currentRegisterMode = RegisterMode.LineWise;

    return new YankOperator().run(vimState, start, end);
  }
}

@RegisterAction
export class DeleteOperatorXVisual extends BaseOperator {
  public keys = [['x'], ['<Del>']];
  public modes = [Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    return new DeleteOperator(this.multicursorIndex).run(vimState, start, end);
  }
}

@RegisterAction
export class ChangeOperatorSVisual extends BaseOperator {
  public keys = ['s'];
  public modes = [Mode.Visual, Mode.VisualLine];

  // Don't clash with Sneak plugin
  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.doesActionApply(vimState, keysPressed) && !configuration.sneak;
  }

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    return new ChangeOperator().run(vimState, start, end);
  }
}

@RegisterAction
export class FormatOperator extends BaseOperator {
  public keys = ['='];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    // = operates on complete lines
    start = new Position(start.line, 0);
    end = end.getLineEnd();
    vimState.editor.selection = new vscode.Selection(start, end);
    await vscode.commands.executeCommand('editor.action.formatSelection');
    let line = vimState.cursorStartPosition.line;

    if (vimState.cursorStartPosition.isAfter(vimState.cursorStopPosition)) {
      line = vimState.cursorStopPosition.line;
    }

    let newCursorPosition = new Position(line, 0).getFirstLineNonBlankChar();
    vimState.cursorStopPosition = newCursorPosition;
    vimState.cursorStartPosition = newCursorPosition;
    await vimState.setCurrentMode(Mode.Normal);
    return vimState;
  }
}

@RegisterAction
export class UpperCaseOperator extends BaseOperator {
  public keys = [['g', 'U'], ['U']];
  public modes = [Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    const range = new vscode.Range(start, new Position(end.line, end.character + 1));
    let text = vimState.editor.document.getText(range);

    await TextEditor.replace(range, text.toUpperCase());

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = start;

    return vimState;
  }
}

@RegisterAction
export class UpperCaseWithMotion extends UpperCaseOperator {
  public keys = [['g', 'U']];
  public modes = [Mode.Normal];
}

@RegisterAction
class UpperCaseVisualBlockOperator extends BaseOperator {
  public keys = [['g', 'U'], ['U']];
  public modes = [Mode.VisualBlock];

  public async run(vimState: VimState, startPos: Position, endPos: Position): Promise<VimState> {
    for (const { start, end } of Position.IterateLine(vimState)) {
      const range = new vscode.Range(start, end);
      let text = vimState.editor.document.getText(range);
      await TextEditor.replace(range, text.toUpperCase());
    }

    const cursorPosition = startPos.isBefore(endPos) ? startPos : endPos;
    vimState.cursorStopPosition = cursorPosition;
    vimState.cursorStartPosition = cursorPosition;
    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }
}

@RegisterAction
export class LowerCaseOperator extends BaseOperator {
  public keys = [['g', 'u'], ['u']];
  public modes = [Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    const range = new vscode.Range(start, new Position(end.line, end.character + 1));
    let text = vimState.editor.document.getText(range);

    await TextEditor.replace(range, text.toLowerCase());

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = start;

    return vimState;
  }
}

@RegisterAction
export class LowerCaseWithMotion extends LowerCaseOperator {
  public keys = [['g', 'u']];
  public modes = [Mode.Normal];
}

@RegisterAction
class LowerCaseVisualBlockOperator extends BaseOperator {
  public keys = [['g', 'u'], ['u']];
  public modes = [Mode.VisualBlock];

  public async run(vimState: VimState, startPos: Position, endPos: Position): Promise<VimState> {
    for (const { start, end } of Position.IterateLine(vimState)) {
      const range = new vscode.Range(start, end);
      let text = vimState.editor.document.getText(range);
      await TextEditor.replace(range, text.toLowerCase());
    }

    const cursorPosition = startPos.isBefore(endPos) ? startPos : endPos;
    vimState.cursorStopPosition = cursorPosition;
    vimState.cursorStartPosition = cursorPosition;
    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }
}

@RegisterAction
class IndentOperator extends BaseOperator {
  modes = [Mode.Normal];
  keys = ['>'];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    vimState.editor.selection = new vscode.Selection(start.getLineBegin(), end.getLineEnd());

    await vscode.commands.executeCommand('editor.action.indentLines');

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = start.obeyStartOfLine();

    return vimState;
  }
}

/**
 * `3>` to indent a line 3 times in visual mode is actually a bit of a special case.
 *
 * > is an operator, and generally speaking, you don't run operators multiple times, you run motions multiple times.
 * e.g. `d3w` runs `w` 3 times, then runs d once.
 *
 * Same with literally every other operator motion combination... until `3>`in visual mode
 * walked into my life.
 */
@RegisterAction
class IndentOperatorInVisualModesIsAWeirdSpecialCase extends BaseOperator {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['>'];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    // Repeating this command with dot should apply the indent to the previous selection
    if (vimState.isRunningDotCommand && vimState.dotCommandPreviousVisualSelection) {
      if (vimState.cursorStartPosition.isAfter(vimState.cursorStopPosition)) {
        const shiftSelectionByNum =
          vimState.dotCommandPreviousVisualSelection.end.line -
          vimState.dotCommandPreviousVisualSelection.start.line;

        start = vimState.cursorStartPosition;
        const newEnd = vimState.cursorStartPosition.getDownByCount(shiftSelectionByNum);

        vimState.editor.selection = new vscode.Selection(start, newEnd);
      }
    }

    for (let i = 0; i < (vimState.recordedState.count || 1); i++) {
      await vscode.commands.executeCommand('editor.action.indentLines');
    }

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = start.obeyStartOfLine();

    return vimState;
  }
}

@RegisterAction
class OutdentOperator extends BaseOperator {
  modes = [Mode.Normal];
  keys = ['<'];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    vimState.editor.selection = new vscode.Selection(start, end.getLineEnd());

    await vscode.commands.executeCommand('editor.action.outdentLines');
    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = start.getFirstLineNonBlankChar();

    return vimState;
  }
}

/**
 * See comment for IndentOperatorInVisualModesIsAWeirdSpecialCase
 */
@RegisterAction
class OutdentOperatorInVisualModesIsAWeirdSpecialCase extends BaseOperator {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['<'];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    // Repeating this command with dot should apply the indent to the previous selection
    if (vimState.isRunningDotCommand && vimState.dotCommandPreviousVisualSelection) {
      if (vimState.cursorStartPosition.isAfter(vimState.cursorStopPosition)) {
        const shiftSelectionByNum =
          vimState.dotCommandPreviousVisualSelection.end.line -
          vimState.dotCommandPreviousVisualSelection.start.line;

        start = vimState.cursorStartPosition;
        const newEnd = vimState.cursorStartPosition.getDownByCount(shiftSelectionByNum);

        vimState.editor.selection = new vscode.Selection(start, newEnd);
      }
    }

    for (let i = 0; i < (vimState.recordedState.count || 1); i++) {
      await vscode.commands.executeCommand('editor.action.outdentLines');
    }

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = start.getFirstLineNonBlankChar();

    return vimState;
  }
}

@RegisterAction
export class ChangeOperator extends BaseOperator {
  public keys = ['c'];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    const isEndOfLine = end.character === end.getLineEnd().character;
    const isLineWise = vimState.currentRegisterMode === RegisterMode.LineWise;
    vimState = await new YankOperator(this.multicursorIndex).run(vimState, start, end);
    // which means the insert cursor would be one to the left of the end of
    // the line. We do want to run delete if it is a multiline change though ex. c}
    vimState.currentRegisterMode = RegisterMode.CharacterWise;
    if (
      TextEditor.getLineLength(TextEditor.getLineAt(start).lineNumber) !== 0 ||
      end.line !== start.line
    ) {
      if (isLineWise) {
        vimState = await new DeleteOperator(this.multicursorIndex).run(
          vimState,
          start.getLineBegin(),
          end.getLineEnd().getLeftThroughLineBreaks(),
          false
        );
      } else if (isEndOfLine) {
        vimState = await new DeleteOperator(this.multicursorIndex).run(
          vimState,
          start,
          end.getLeftThroughLineBreaks(),
          false
        );
      } else {
        vimState = await new DeleteOperator(this.multicursorIndex).run(vimState, start, end, false);
      }
    }
    vimState.currentRegisterMode = RegisterMode.AscertainFromCurrentMode;

    await vimState.setCurrentMode(Mode.Insert);

    if (isEndOfLine) {
      vimState.cursorStopPosition = end.getRight();
    }

    return vimState;
  }

  public async runRepeat(vimState: VimState, position: Position, count: number): Promise<VimState> {
    const thisLineIndent = vimState.editor.document.getText(
      new vscode.Range(position.getLineBegin(), position.getLineBeginRespectingIndent())
    );

    vimState.currentRegisterMode = RegisterMode.LineWise;

    vimState = await this.run(
      vimState,
      position.getLineBegin(),
      position.getDownByCount(Math.max(0, count - 1)).getLineEnd()
    );

    if (configuration.autoindent) {
      if (vimState.editor.document.languageId === 'plaintext') {
        vimState.recordedState.transformations.push({
          type: 'insertText',
          text: thisLineIndent,
          position: position.getLineBegin(),
          cursorIndex: this.multicursorIndex,
        });
      } else {
        vimState.recordedState.transformations.push({
          type: 'reindent',
          cursorIndex: this.multicursorIndex,
          diff: new PositionDiff({ character: 1 }), // Handle transition from Normal to Insert modes
        });
      }
    }

    return vimState;
  }
}

@RegisterAction
export class YankVisualBlockMode extends BaseOperator {
  public keys = ['y'];
  public modes = [Mode.VisualBlock];
  canBeRepeatedWithDot = false;
  mightChangeDocument = false;
  runsOnceForEveryCursor() {
    return false;
  }

  public async run(vimState: VimState, startPos: Position, endPos: Position): Promise<VimState> {
    let toCopy: string = '';
    const ranges: vscode.Range[] = [];

    const isMultiline = startPos.line !== endPos.line;

    for (const { line, start, end } of Position.IterateLine(vimState)) {
      ranges.push(new vscode.Range(start, end));
      if (isMultiline) {
        toCopy += line + '\n';
      } else {
        toCopy = line;
      }
    }

    vimState.currentRegisterMode = RegisterMode.BlockWise;

    this.highlightYankedRanges(vimState, ranges);

    Register.put(toCopy, vimState, this.multicursorIndex);

    vimState.historyTracker.addMark(startPos, '<');
    vimState.historyTracker.addMark(endPos, '>');

    const numLinesYanked = toCopy.split('\n').length;
    reportLinesYanked(numLinesYanked, vimState);

    await vimState.setCurrentMode(Mode.Normal);
    vimState.cursorStopPosition = startPos;
    return vimState;
  }
}

@RegisterAction
export class ToggleCaseOperator extends BaseOperator {
  public keys = ['~'];
  public modes = [Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    const range = new vscode.Range(start, end.getRight());

    await ToggleCaseOperator.toggleCase(range);

    const cursorPosition = start.isBefore(end) ? start : end;
    vimState.cursorStopPosition = cursorPosition;
    vimState.cursorStartPosition = cursorPosition;
    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }

  static async toggleCase(range: vscode.Range) {
    const text = TextEditor.getText(range);

    let newText = '';
    for (const char of text) {
      // Try lower-case
      let toggled = char.toLocaleLowerCase();
      if (toggled === char) {
        // Try upper-case
        toggled = char.toLocaleUpperCase();
      }
      newText += toggled;
    }
    await TextEditor.replace(range, newText);
  }
}

@RegisterAction
class ToggleCaseVisualBlockOperator extends BaseOperator {
  public keys = ['~'];
  public modes = [Mode.VisualBlock];

  public async run(vimState: VimState, startPos: Position, endPos: Position): Promise<VimState> {
    for (const { start, end } of Position.IterateLine(vimState)) {
      const range = new vscode.Range(start, end);
      await ToggleCaseOperator.toggleCase(range);
    }

    const cursorPosition = startPos.isBefore(endPos) ? startPos : endPos;
    vimState.cursorStopPosition = cursorPosition;
    vimState.cursorStartPosition = cursorPosition;
    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }
}

@RegisterAction
class ToggleCaseWithMotion extends ToggleCaseOperator {
  public keys = ['g', '~'];
  public modes = [Mode.Normal];
}

@RegisterAction
export class CommentOperator extends BaseOperator {
  public keys = ['g', 'c'];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    vimState.editor.selection = new vscode.Selection(start.getLineBegin(), end.getLineEnd());
    await vscode.commands.executeCommand('editor.action.commentLine');

    vimState.cursorStopPosition = new Position(start.line, 0);
    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }
}

@RegisterAction
export class ROT13Operator extends BaseOperator {
  public keys = ['g', '?'];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    let selections: vscode.Selection[];
    if (isVisualMode(vimState.currentMode)) {
      selections = vimState.editor.selections;
    } else if (vimState.currentRegisterMode === RegisterMode.LineWise) {
      selections = [new vscode.Selection(start.getLineBegin(), end.getLineEnd())];
    } else {
      selections = [new vscode.Selection(start, end.getRight())];
    }

    for (const range of selections) {
      const original = TextEditor.getText(range);
      vimState.recordedState.transformations.push({
        type: 'replaceText',
        text: ROT13Operator.rot13(original),
        start: Position.FromVSCodePosition(range.start),
        end: Position.FromVSCodePosition(range.end),
      });
    }

    return vimState;
  }

  /**
   * https://en.wikipedia.org/wiki/ROT13
   */
  public static rot13(str: string) {
    return str
      .split('')
      .map((char: string) => {
        let charCode = char.charCodeAt(0);

        if (char >= 'a' && char <= 'z') {
          const a = 'a'.charCodeAt(0);
          charCode = ((charCode - a + 13) % 26) + a;
        }

        if (char >= 'A' && char <= 'Z') {
          const A = 'A'.charCodeAt(0);
          charCode = ((charCode - A + 13) % 26) + A;
        }

        return String.fromCharCode(charCode);
      })
      .join('');
  }
}

@RegisterAction
export class CommentBlockOperator extends BaseOperator {
  public keys = ['g', 'C'];
  public modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    if (vimState.currentMode === Mode.Normal) {
      // If we're in normal mode, we need to construct a selection for the
      // command to operate on. If we're not, we've already got it.
      const endPosition = end.getRight();
      vimState.editor.selection = new vscode.Selection(start, endPosition);
    }
    await vscode.commands.executeCommand('editor.action.blockComment');

    vimState.cursorStopPosition = start;
    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }
}

interface CommentStyle {
  indent: string; // indent of prefix which satisfies: `/^\s+$/`
  prefix: string; // prefix of comment
  gap:    string; // gap between prefix and comment
}

@RegisterAction
class ActionVisualReflowParagraph extends BaseOperator {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['g', 'q'];

  public prefixTypes = [
    // If a prefix is the prefix of another prefix, it should be placed after.

    '/*',
    /* vim doesn't supports them
      '///',
      '--',
      '#',
      ';',
    */
    '//',
    '-',
    '*/',
    '*',
  ];

  // Get how many spaces the given indent is equivalent to
  public getSpaceLevel(indent: string): number {
      let spaceLevel = 0;
      for (const ch of indent) {
        spaceLevel += ch === '\t' ? configuration.tabstop : 1;
      }
      return spaceLevel;
  }

  // Get comment style of the given line
  public getCommentStyle(line: string): CommentStyle {
    let matchResult: RegExpMatchArray | null = null;

    for (const prefix of this.prefixTypes) {
      matchResult = line.match(new RegExp(`^\\\s*${prefix}\\\s*`));
      if (!matchResult) {
        continue;
      }
      // part the string we matched
      let matchedPart = matchResult[0];

      // get span of prefix so we can infer the indent and gap
      matchResult = matchedPart.match(new RegExp(prefix));
      if (!matchResult || !matchResult.index) {
        continue;
      }
      let prefixBegin: number = matchResult.index;
      let prefixEnd: number = matchResult.index + matchResult[0].length;

      return {
        indent:   matchedPart.slice(0, prefixBegin),
        prefix:   prefix,
        gap:      matchedPart.slice(prefixEnd)
      };
    }

    // If no legal prefix is found, we return the pure indent
    matchResult = line.match(/^\s*/);
    if (!matchResult) {
      return {
        indent: '',
        prefix: '',
        gap: '',
      };
    }
    return {
      indent: matchResult[0],
      prefix: '',
      gap: '',
    };
  }

  public reflowParagraph(s: string): string {
    let previousStyle: CommentStyle = { indent: '', prefix: '', gap: '' };
    let currentComment;

    for (const line of s.split('\n')) {
      const currentStyle = this.getCommentStyle(line);

      const indentLevel = this.getSpaceLevel(currentStyle.indent);
      const gapLevel = this.getSpaceLevel(currentStyle.gap);

      // const commentOffset = currentStyle.indent.length + currentStyle.prefix.length + currentStyle.gap.length;
      const commentOffsetLevel = indentLevel + currentStyle.prefix.length + gapLevel;

      const maximumLineLength = configuration.textwidth - commentOffsetLevel - 2;

      // const  = this.getSpaceLevel;

      previousStyle = currentStyle;
    }

    return '';
  }

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    // Extend the selection span
    start = start.getLineBegin();
    end = end.getLineEnd();

    let textToReflow = TextEditor.getText(new vscode.Range(start, end));
    let textReflowed = this.reflowParagraph(textToReflow);

    vimState.recordedState.transformations.push({
      type: 'replaceText',
      text: textReflowed,
      start: start,
      end: end,
      // donoughliu suspecious here
      // Move cursor to front of line to realign the view
      diff: PositionDiff.newBOLDiff(),
    });

    await vimState.setCurrentMode(Mode.Normal);

    return vimState;
  }
}
