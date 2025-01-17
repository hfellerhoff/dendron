import { NoteQuickInput } from "@dendronhq/common-all";
import { HistoryService } from "@dendronhq/engine-server";
import _ from "lodash";
import { CancellationToken, window } from "vscode";
import { Logger } from "../../logger";
import { getDurationMilliseconds } from "../../utils/system";
import { DendronWorkspace } from "../../workspace";
import { LookupControllerV3 } from "./LookupControllerV3";
import { DendronQuickPickerV2 } from "./types";
import { NotePickerUtils, PickerUtilsV2 } from "./utils";

export type OnUpdatePickerItemsOpts = {
  picker: DendronQuickPickerV2;
  token: CancellationToken;
  enableCreateNew?: boolean;
};

export type ILookupProviderV3 = {
  provide: (lc: LookupControllerV3) => Promise<void>;
  onUpdatePickerItems: (opts: OnUpdatePickerItemsOpts) => Promise<void>;
};

export class NoteLookupProvider implements ILookupProviderV3 {
  async provide(lc: LookupControllerV3) {
    const quickpick = lc.quickpick;
    if (!quickpick) {
      return;
    }
    quickpick.onDidChangeValue(() => {
      _.debounce(_.bind(this.onUpdatePickerItems, this), 60, {
        leading: true,
        maxWait: 120,
      })({ picker: quickpick, token: lc.createCancelSource().token });
    });
    quickpick.onDidAccept(this.onDidAccept({ quickpick, lc }));
    return;
  }

  getVault() {
    return PickerUtilsV2.getVaultForOpenEditor();
  }

  onDidAccept(opts: {
    quickpick: DendronQuickPickerV2;
    lc: LookupControllerV3;
  }) {
    return async () => {
      const { quickpick: picker, lc } = opts;
      const selectedItems = NotePickerUtils.getSelection(picker);
      lc.cancelToken.cancel();
      picker.hide();
      HistoryService.instance().add({
        source: "lookupProvider",
        action: "done",
        data: selectedItems,
      });
      return;
    };
  }

  async onUpdatePickerItems(opts: OnUpdatePickerItemsOpts) {
    const { picker, token } = opts;
    const ctx = "updatePickerItems";
    picker.busy = true;
    let pickerValue = picker.value;
    const start = process.hrtime();
    if (picker.justActivated) {
      // no hiearchy, query everything
      const lastDotIndex = pickerValue.lastIndexOf(".");
      if (lastDotIndex < 0) {
        pickerValue = "";
      } else {
        // assume query from last dot
        pickerValue = pickerValue.slice(0, lastDotIndex + 1);
      }
    }

    // get prior
    const querystring = PickerUtilsV2.slashToDot(pickerValue);
    const queryOrig = PickerUtilsV2.slashToDot(picker.value);
    // const depth = queryOrig.split(".").length;
    const ws = DendronWorkspace.instance();
    // const vault = this.getVault();
    let profile: number;
    const queryEndsWithDot = queryOrig.endsWith(".");
    // const queryUpToLastDot =
    //   queryOrig.lastIndexOf(".") >= 0
    //     ? queryOrig.slice(0, queryOrig.lastIndexOf("."))
    //     : undefined;

    const engine = ws.getEngine();
    Logger.info({ ctx, msg: "enter", queryOrig });
    try {
      if (querystring === "") {
        Logger.debug({ ctx, msg: "empty qs" });
        picker.items = NotePickerUtils.fetchRootResults({ engine });
        return;
      }

      // current items without default items present
      const items: NoteQuickInput[] = [...picker.items];
      let updatedItems = PickerUtilsV2.filterDefaultItems(items);
      if (token.isCancellationRequested) {
        return;
      }

      updatedItems = await NotePickerUtils.fetchPickerResults({
        picker,
        qs: querystring,
      });
      if (token.isCancellationRequested) {
        return;
      }

      // check if single item query, vscode doesn't surface single letter queries
      if (picker.activeItems.length === 0 && querystring.length === 1) {
        picker.items = updatedItems;
        picker.activeItems = picker.items;
        return;
      }

      // const perfectMatch = _.find(updatedItems, { fname: queryOrig });
      // // NOTE: we modify this later so need to track this here
      // const noUpdatedItems = updatedItems.length === 0;

      if (queryEndsWithDot) {
        // don't show noActiveItem for dot queries
        Logger.debug({ ctx, msg: "active != qs, end with ." });
        picker.items = PickerUtilsV2.filterCreateNewItem(updatedItems);
      } else {
        // regular result
        Logger.debug({ ctx, msg: "active != qs" });
        picker.items = updatedItems;
      }
    } catch (err) {
      window.showErrorMessage(err);
      throw Error(err);
    } finally {
      profile = getDurationMilliseconds(start);
      picker.busy = false;
      picker.justActivated = false;
      Logger.info({
        ctx,
        msg: "exit",
        queryOrig,
        profile,
        cancelled: token.isCancellationRequested,
      });
      return;
    }
  }
}
