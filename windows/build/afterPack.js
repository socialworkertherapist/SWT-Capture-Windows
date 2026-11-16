// Embed the app icon and version info into the Windows .exe without needing Wine/rcedit.
const path = require('path');
const fs = require('fs');
module.exports = async (context) => {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const R = ResEdit.default || ResEdit; const P = PE.default || PE;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const data = fs.readFileSync(exe);
  const exeObj = P.NtExecutable.from(data, { ignoreCert: true });
  const res = P.NtExecutableResource.from(exeObj);
  const iconFile = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map(i => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const v = context.packager.appInfo.version.split('.').map(Number);
    vi.setFileVersion(v[0], v[1], v[2], 0, 1033);
    vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: 'SWT Capture', FileDescription: 'SWT Capture — screen & audio recorder',
      CompanyName: 'Social Worker Therapist', LegalCopyright: '© Linda Au', OriginalFilename: 'SWT Capture.exe', InternalName: 'SWT Capture'
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exeObj);
  fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
  console.log('  • embedded icon + version info', exe);
};
