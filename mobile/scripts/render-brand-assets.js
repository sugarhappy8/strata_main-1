"use strict";
// Renders the iOS app icon and launch image from STRATA's logo (public/icons/strata-icon.svg).
// Usage (from mobile/): node scripts/render-brand-assets.js
// Needs the repository's Playwright install (npm ci at the root) and ImageMagick's `convert`,
// which removes the alpha channel App Store Connect rejects on app icons.
const {execFileSync}=require("node:child_process");
const {mkdtempSync,rmSync,writeFileSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");

const ROOT=join(__dirname,"..","..");
const ASSETS=join(__dirname,"..","ios","App","App","Assets.xcassets");
const {chromium}=require(join(ROOT,"node_modules","playwright"));
const INK="#10110f";
// The logo's bars and baseline, without the rounded tile: iOS applies its own icon mask.
const MARK='<path d="M250 666 330 666 382 438 302 438Z" fill="#faf9f5"/><path d="M410 666 502 666 576 338 484 338Z" fill="#d9ff43"/><path d="M594 666 700 666 798 232 692 232Z" fill="#faf9f5"/><path d="M238 744H786" stroke="#ff5a36" stroke-width="32" stroke-linecap="square"/>';

function page(size,markSize){
  const offset=(size-markSize)/2;
  return `<!doctype html><html><body style="margin:0;background:${INK}"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${INK}"/><g transform="translate(${offset} ${offset}) scale(${markSize/1024})">${MARK}</g></svg></body></html>`;
}

(async()=>{
  const work=mkdtempSync(join(tmpdir(),"strata-ios-assets-"));
  const browser=await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{});
  try{
    const outputs=[
      {name:"icon",size:1024,mark:1024,targets:[join(ASSETS,"AppIcon.appiconset","AppIcon-512@2x.png")]},
      {name:"splash",size:2732,mark:620,targets:["splash-2732x2732.png","splash-2732x2732-1.png","splash-2732x2732-2.png"].map((file)=>join(ASSETS,"Splash.imageset",file))}
    ];
    for(const output of outputs){
      const context=await browser.newContext({viewport:{width:output.size,height:output.size},deviceScaleFactor:1});
      const tab=await context.newPage();
      await tab.setContent(page(output.size,output.mark));
      const raw=join(work,`${output.name}.png`);
      await tab.screenshot({path:raw,clip:{x:0,y:0,width:output.size,height:output.size}});
      await context.close();
      for(const target of output.targets){
        // Flatten onto the ink color and drop alpha: App Store Connect refuses icons with an alpha channel.
        execFileSync("convert",[raw,"-background",INK,"-alpha","remove","-alpha","off","-strip",`PNG24:${target}`]);
      }
    }
    writeFileSync(join(work,"done"),"");
  }finally{
    await browser.close();
    rmSync(work,{recursive:true,force:true});
  }
})();
