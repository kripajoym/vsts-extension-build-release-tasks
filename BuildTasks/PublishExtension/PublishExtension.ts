import * as tl from "vsts-task-lib/task";
import * as common from "./common";
import * as vsixeditor from "./vsixeditor";

void common.runTfx(async tfx => {
    tfx.arg(["extension", "publish", "--json", "--no-color"]);
    const outputVariable = tl.getInput("outputVariable", false);

    common.setTfxMarketplaceArguments(tfx);

    // Read file type
    const fileType = tl.getInput("fileType", true);
    let vsixOutput;
    let cleanupTfxArgs: () => void;
    let runBeforeTfx: Promise<boolean> = Promise.resolve(true);

    if (fileType === "manifest") {
        // Set tfx manifest arguments
        cleanupTfxArgs = common.validateAndSetTfxManifestArguments(tfx);

        // Update tasks version if needed
        runBeforeTfx = runBeforeTfx.then(() => { common.checkUpdateTasksManifests(); return true; });
    } else {
        // Set vsix file argument
        let vsixFilePattern = tl.getPathInput("vsixFile", true);
        let matchingVsixFile: string[];
        if (vsixFilePattern.indexOf("*") >= 0 || vsixFilePattern.indexOf("?") >= 0) {
            tl.debug("Pattern found in vsixFile parameter");
            matchingVsixFile = tl.findMatch(tl.getInput("cwd", false) || process.cwd(), vsixFilePattern);
        }
        else {
            tl.debug("No pattern found in vsixFile parameter");
            matchingVsixFile = [vsixFilePattern];
        }

        if (!matchingVsixFile || matchingVsixFile.length === 0) {
            tl.setResult(tl.TaskResult.Failed, `Found no vsix files matching: ${vsixFilePattern}.`);
            return false;
        }
        if (matchingVsixFile.length !== 1) {
            tl.setResult(tl.TaskResult.Failed, `Found multiple vsix files matching: ${vsixFilePattern}.`);
            return false;
        }

        const vsixFile = matchingVsixFile[0];
        tl.checkPath(vsixFile, "vsixPath");

        vsixOutput = tl.getVariable("System.DefaultWorkingDirectory");

        const publisher = tl.getInput("publisherId", false);

        const extensionId = tl.getInput("extensionId", false);
        const extensionTag = tl.getInput("extensionTag", false);

        const extensionName = tl.getInput("extensionName", false);
        const extensionVisibility = tl.getInput("extensionVisibility", false) || "";
        const extensionPricing = tl.getInput("extensionPricing", false);
        const extensionVersion = common.getExtensionVersion();
        const updateTasksId = tl.getBoolInput("updateTasksId", false);
        const updateTasksVersion = tl.getBoolInput("updateTasksVersion", false);

        if (publisher
            || extensionId
            || extensionTag
            || extensionName
            || (extensionPricing && extensionPricing !== "default")
            || (extensionVisibility && extensionVisibility !== "default")
            || extensionVersion
            || updateTasksId ) {

            tl.debug("Start editing of VSIX");
            let ve = new vsixeditor.VSIXEditor(vsixFile, vsixOutput);
            ve.startEdit();

            if (publisher) { ve.editPublisher(publisher); }
            if (extensionId) { ve.editId(extensionId); }
            if (extensionTag) { ve.editIdTag(extensionTag); }
            if (extensionName) { ve.editExtensionName(extensionName); }
            if (extensionVisibility) { ve.editExtensionVisibility(extensionVisibility); }
            if (extensionPricing) { ve.editExtensionPricing(extensionPricing); }
            if (extensionVersion) {
                ve.editVersion(extensionVersion);
                ve.editUpdateTasksVersion(updateTasksVersion);
            }
            if (updateTasksId) {
                ve.editUpdateTasksId(updateTasksId);
            }

            runBeforeTfx = runBeforeTfx.then(() => ve.endEdit().then(vsixGeneratedFile => {
                tfx.arg(["--vsix", vsixGeneratedFile]);
                vsixOutput = vsixGeneratedFile;
                return true;
            }));
        }
        else {
            vsixOutput = vsixFile;
            tfx.arg(["--vsix", vsixOutput]);
        }
    }

    // Share with
    const shareWith = tl.getDelimitedInput("shareWith", ",", false).map((value) => { return value.trim(); });
    const extensionVisibility = tl.getInput("extensionVisibility", false) || "";
    const connectTo = tl.getInput("connectTo", true);
    if (shareWith) {
        if (connectTo === "TFS") {
            tl.warning("Ignoring Share - Not available on TFS.");
        }
        else if (extensionVisibility.indexOf("public") < 0) {
            // Only handle shareWith if the extension is not public
            tfx.argIf(shareWith && shareWith.length > 0, ["--share-with"].concat(shareWith));
        } else if (shareWith && shareWith.length > 0) {
            tl.warning("Ignoring Share - Not available on public extensions.");
        }
    }

    const noWaitValidation = tl.getBoolInput("noWaitValidation", false);
    if (noWaitValidation) {
        tl.debug(`Not waiting for validation.`);
        tfx.arg("--no-wait-validation");
    }

    const bypassLocalValidation = tl.getBoolInput("bypassLocalValidation", false);
    if (bypassLocalValidation) {
        tl.debug(`Bypassing local validation.`);
        tfx.arg("--bypass-validation");
    }

    const args = tl.getInput("arguments", false);
    if (args) {
        tl.debug(`Adding additional arguments: ${args}.`);
        tfx.line(args);
    }

    try {
        tl.debug(`Run tfx.`);
        await runBeforeTfx;
        const outputStream = new common.TfxJsonOutputStream(true);
        const code = await tfx.exec({ outStream: outputStream, failOnStdErr: true } as any);
        const json = JSON.parse(outputStream.jsonString);

        const publishedVsix = fileType === "manifest" ? json.packaged : vsixOutput;

        if (outputVariable) {
            tl.setVariable(outputVariable, publishedVsix);
        }

        console.log(`Published VSIX: ${publishedVsix}.`);
        tl.setResult(tl.TaskResult.Succeeded, `tfx exited with return code: ${code}`);
    }catch (err) {
        tl.setResult(tl.TaskResult.Failed, `tfx failed with error: ${err}`);
        return false;
    } finally {
        if (cleanupTfxArgs) { cleanupTfxArgs(); }
    }
    return true;
});
