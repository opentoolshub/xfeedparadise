#!/usr/bin/env python3
"""Post-process the project produced by safari-web-extension-converter.

The converter references each extension file individually. That would fork
the file list (and go stale whenever the manifest changes), so this script:

* removes those file references and their Copy Bundle Resources entries,
* adds a "Sync web extension" Run Script phase to each extension target that
  runs sync-extension.py straight into the .appex resources,
* turns off user-script sandboxing (the phase reads the repo-root sources),
* sets the team, versions, deployment targets, export-compliance and
  app-category Info.plist keys.

Run once after (re)generating the project; it refuses to run twice.
usage: postprocess-xcodeproj.py PATH/TO/project.pbxproj VERSION
"""
import re
import sys

TEAM = "JESMXK96LG"
IOS_TARGET = "16.0"
MACOS_TARGET = "12.0"
PHASE_ID = {"iOS": "AF00000000000000000000A1", "macOS": "AF00000000000000000000A2"}
SCRIPT = ('set -e\\n'
          '/usr/bin/python3 \\"${PROJECT_DIR}/../scripts/sync-extension.py\\" '
          '--out \\"${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}\\"\\n')


def main(path, version):
    text = open(path, encoding="utf-8").read()
    if "Sync web extension" in text:
        sys.exit("already post-processed")

    # File references the converter made into the generated WebExtension dir.
    refs = re.findall(r"^\t\t([0-9A-F]{24}) /\* [^*]+ \*/ = \{isa = PBXFileReference;[^\n]*path = \"?(?:\.\./)+[^;\"]*WebExtension/",
                      text, re.M)
    if not refs:
        sys.exit("no WebExtension file references found")
    builds = re.findall(r"^\t\t([0-9A-F]{24}) /\* [^*]+ \*/ = \{isa = PBXBuildFile; fileRef = (%s) " % "|".join(refs), text, re.M)
    gone = set(refs) | {b for b, _ in builds}
    lines = [line for line in text.split("\n")
             if not any(line.lstrip("\t").startswith(i + " ") for i in gone)]
    text = "\n".join(lines)

    # Drop the now-empty converter "Resources" group under Shared (Extension).
    group = re.search(r"^\t\t([0-9A-F]{24}) /\* Resources \*/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\);\n"
                      r"\t\t\tname = Resources;\n\t\t\tpath = \"Shared \(Extension\)\";\n\t\t\tsourceTree = SOURCE_ROOT;\n\t\t\};\n", text, re.M)
    if group:
        text = text.replace(group.group(0), "")
        text = re.sub(r"^\t\t\t\t%s /\* Resources \*/,\n" % group.group(1), "", text, flags=re.M)

    # Run Script phase in each extension target, before Copy Bundle Resources.
    phases = []
    for platform, pid in PHASE_ID.items():
        target = re.search(r"/\* XFeed Paradise Extension \(%s\) \*/ = \{\n\t\t\tisa = PBXNativeTarget;.*?buildPhases = \(\n(.*?)\t\t\t\);" % platform,
                           text, re.S)
        sources = target.group(1).split("\n")[0]
        text = text.replace(target.group(0), target.group(0).replace(
            sources, sources + "\n\t\t\t\t%s /* Sync web extension */," % pid, 1), 1)
        phases.append(
            "\t\t%s /* Sync web extension */ = {\n"
            "\t\t\tisa = PBXShellScriptBuildPhase;\n"
            "\t\t\talwaysOutOfDate = 1;\n"
            "\t\t\tbuildActionMask = 2147483647;\n"
            "\t\t\tfiles = (\n\t\t\t);\n"
            "\t\t\tinputFileListPaths = (\n\t\t\t);\n"
            "\t\t\tinputPaths = (\n\t\t\t);\n"
            "\t\t\tname = \"Sync web extension\";\n"
            "\t\t\toutputFileListPaths = (\n\t\t\t);\n"
            "\t\t\toutputPaths = (\n\t\t\t);\n"
            "\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
            "\t\t\tshellPath = /bin/sh;\n"
            "\t\t\tshellScript = \"%s\";\n"
            "\t\t};\n" % (pid, SCRIPT))
    text = text.replace("/* End PBXResourcesBuildPhase section */",
                        "/* End PBXResourcesBuildPhase section */\n\n/* Begin PBXShellScriptBuildPhase section */\n"
                        + "".join(phases) + "/* End PBXShellScriptBuildPhase section */", 1)

    text = text.replace("ENABLE_USER_SCRIPT_SANDBOXING = YES;", "ENABLE_USER_SCRIPT_SANDBOXING = NO;")
    text = re.sub(r"IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;", "IPHONEOS_DEPLOYMENT_TARGET = %s;" % IOS_TARGET, text)
    text = re.sub(r"MACOSX_DEPLOYMENT_TARGET = [0-9.]+;", "MACOSX_DEPLOYMENT_TARGET = %s;" % MACOS_TARGET, text)
    text = re.sub(r"MARKETING_VERSION = [0-9.]+;", "MARKETING_VERSION = %s;" % version, text)
    text = re.sub(r"(\t+)(PRODUCT_BUNDLE_IDENTIFIER = )", r"\1DEVELOPMENT_TEAM = %s;\n\1\2" % TEAM, text)
    app_name = '\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "XFeed Paradise";\n'
    text = text.replace(app_name, app_name
                        + '\t\t\t\tINFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;\n'
                        + '\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.productivity";\n')
    open(path, "w", encoding="utf-8").write(text)
    print("post-processed %s: removed %d references, added %d sync phases" % (path, len(gone), len(phases)))


if __name__ == "__main__":
    main(*sys.argv[1:3])
