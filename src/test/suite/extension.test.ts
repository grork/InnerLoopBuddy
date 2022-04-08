import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
	vscode.window.showInformationMessage("Start all tests.");

	test("Sample Workspace was opened", () => {
		assert.strictEqual(vscode.workspace.name, "sample-project");
	});
});