const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const gitExtension = vscode.extensions.getExtension('vscode.git-base')?.exports;
	const gitAPI = gitExtension?.getAPI(1);

	if (!gitAPI) {
		vscode.window.showErrorMessage('Git extension API not available');
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showWarningMessage('No workspace folders found.');
		return;
	}

	const alProjects = [];

	for (const folder of workspaceFolders) {
		try {
			const appJsonPath = path.join(folder.uri.fsPath, 'app.json');
			if (!fs.existsSync(appJsonPath)) continue;

			const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

			const { name, version, publisher } = appJson;
			if (!name || !version || !publisher) {
				vscode.window.showErrorMessage(`Invalid app.json in ${folder.name}`);
				continue;
			}

			alProjects.push(createALProject(folder, name, version, publisher));
		} catch (error) {
			vscode.window.showErrorMessage(`Error reading app.json: ${error.message}`);
		}
	}

	vscode.window.registerTreeDataProvider(
		'dsc-al-manager',
		new ALManagerTreeDataProvider(alProjects)
	);

	console.log('DSC AL Manager is now active!');
}

/**
 * Creates an ALProject instance with version and publisher as child items
 */
function createALProject(folder, name, version, publisher) {
	const versionItem = new vscode.TreeItem(`Version: ${version}`);
	versionItem.contextValue = 'versionItem';

	const publisherItem = new vscode.TreeItem(`Publisher: ${publisher}`);

	const project = new ALProject(name, folder, vscode.TreeItemCollapsibleState.Collapsed, [
		versionItem,
		publisherItem
	]);

	project.command = {
		command: 'dsc-al-manager.selectProject',
		title: 'Select Project',
		arguments: [project]
	};
	project.description = version;
	project.contextValue = 'alProject';
	return project;
}

class ALProject extends vscode.TreeItem {
	constructor(label, folder, collapsibleState, children = []) {
		super(label, collapsibleState);
		this.children = children;
		this.folder = folder; // To access app.json path
	}
}

class ALManagerTreeDataProvider {
	_onDidChangeTreeData = new vscode.EventEmitter();
	onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(projects) {
		this.projects = projects;
		this.selectedProject = null;
		this.watchers = [];

		this.registerCommands();
		this.registerWatchers();
	}

	getTreeItem(element) {
		return element;
	}

	getChildren(element) {
		return element ? element.children : this.projects;
	}

	registerCommands() {
		vscode.commands.registerCommand('dsc-al-manager.selectProject', (item) => {
			this.selectedProject = item;
		});

		vscode.commands.registerCommand('dsc-al-manager.upVersionFix', (item) => this.bumpVersion('fix', item));
		vscode.commands.registerCommand('dsc-al-manager.upVersionMinor', (item) => this.bumpVersion('minor', item));
		vscode.commands.registerCommand('dsc-al-manager.upVersionMajor', (item) => this.bumpVersion('major', item));
		vscode.commands.registerCommand('dsc-al-manager.upVersion', (item) => this.bumpVersion('majorReset', item));
		vscode.commands.registerCommand('dsc-al-manager.addChangelogEntry', (project) => this.addChangelogEntry(project));
	}

	bumpVersion(type, item) {

		const versionItem = item.children?.[0];
		if (!versionItem || !versionItem.label.startsWith('Version: ')) {
			vscode.window.showErrorMessage('Invalid version item.');
			return;
		}

		const versionStr = versionItem.label.replace('Version: ', '');
		const segments = versionStr.split('.').map(n => parseInt(n));

		if (segments.length !== 4 || segments.some(isNaN)) {
			vscode.window.showErrorMessage('Malformed version string.');
			return;
		}

		let [major, minor, patch, build] = segments;

		switch (type) {
			case 'fix': build += 1; break;
			case 'minor': patch += 1; build = 0; break;
			case 'major': minor += 1; patch = 0; build = 0; break;
			case 'majorReset': major += 1; minor = patch = build = 0; break;
		}

		const newVersion = `${major}.${minor}.${patch}.${build}`;
		versionItem.label = `Version: ${newVersion}`;
		item.description = newVersion;
		this.updateAppJsonVersion(item.folder.uri.fsPath, newVersion);
		this._onDidChangeTreeData.fire();
	}

	updateAppJsonVersion(projectPath, newVersion) {
		const appJsonPath = path.join(projectPath, 'app.json');

		try {
			const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
			appJson.version = newVersion;
			fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2), 'utf8');
			vscode.window.showInformationMessage(`Updated version to ${newVersion}`);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to update app.json: ${error.message}`);
		}
	}

	async addChangelogEntry(project) {
		const changelogPath = path.join(project.folder.uri.fsPath, 'changelog.json');

		let changelog = [];

		// Load or create the file
		if (fs.existsSync(changelogPath)) {
			try {
				changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to read changelog.json: ${err.message}`);
				return;
			}
		}

		const currentVersion = project.description; // e.g. "23.0.0.3"
		let versionEntry = changelog.find(e => e.version === currentVersion);

		if (!versionEntry) {
			// Ask for main version title
			const versionTitle = await vscode.window.showInputBox({
				title: `New version: ${currentVersion}`,
				prompt: 'Enter main title for this version',
				ignoreFocusOut: true
			});
			if (!versionTitle) return;

			versionEntry = {
				version: currentVersion,
				title: versionTitle,
				details: []
			};
			changelog.unshift(versionEntry);
		}

		// Ask for detail entry
		const detailTitle = await vscode.window.showInputBox({
			title: 'New changelog detail',
			prompt: 'Enter detail title',
			ignoreFocusOut: true
		});
		if (!detailTitle) return;

		const detailText = await vscode.window.showInputBox({
			title: 'New changelog detail',
			prompt: 'Enter detail text',
			ignoreFocusOut: true
		});
		if (!detailText) return;

		// Add new detail entry
		const newDetail = {
			id: versionEntry.details.length + 1,
			title: detailTitle,
			detail: detailText
		};
		versionEntry.details.push(newDetail);

		// Save the changelog
		try {
			fs.writeFileSync(changelogPath, JSON.stringify(changelog, null, 2), 'utf8');
			vscode.window.showInformationMessage(`Changelog updated for version ${currentVersion}`);
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to save changelog: ${err.message}`);
		}
	}

	registerWatchers() {
		for (const project of this.projects) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.folder.uri.fsPath, 'app.json'));

			watcher.onDidChange(() => this.reloadProject(project));
			watcher.onDidCreate(() => this.reloadProject(project));
			watcher.onDidDelete(() => this.reloadProject(project));

			this.watchers.push(watcher);
		}
	}

	reloadProject(project) {
		try {
			const appJsonPath = path.join(project.folder.uri.fsPath, 'app.json');
			if (!fs.existsSync(appJsonPath)) return;

			const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
			const { version, publisher } = appJson;

			project.children = [
				new vscode.TreeItem(`Version: ${version}`),
				new vscode.TreeItem(`Publisher: ${publisher}`)
			];

			project.description = version;

			this._onDidChangeTreeData.fire(project);

			// Reset selected project if this one is being edited manually
			if (this.selectedProject === project) {
				this.selectedProject = project; // Ensure latest child references
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to reload ${project.label}: ${err.message}`);
		}
	}

}

function deactivate() { }

module.exports = {
	activate,
	deactivate
};
