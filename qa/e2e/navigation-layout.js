"use strict";
/* global document, getComputedStyle, innerWidth, NodeFilter */

const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join,resolve}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..","..");
const read=(path)=>readFileSync(join(ROOT,path),"utf8");
const sharedCss=read("public/styles/product-nav.css")+"\n"+read("public/styles/site-experience.css");

function headerFrom(path){
  const match=read(path).match(/<header\b[\s\S]*?<\/header>/i);
  assert.ok(match,`${path} must contain a header`);
  return match[0];
}

test("account and setup navigation fit narrow screens with touch-sized targets",{timeout:30_000},async()=>{
  const options={headless:true};
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  const browser=await chromium.launch(options);
  try{
    const fixtures=[
      {name:"account",header:headerFrom("public/pages/account.html"),css:`${read("public/styles/account.css")}\n${sharedCss}`,current:"Account"},
      {name:"setup",header:headerFrom("public/pages/onboarding.html"),css:`${read("public/styles/onboarding.css")}\n${sharedCss}`,current:null}
    ];
    for(const width of [320,390])for(const fixture of fixtures){
      const page=await browser.newPage({viewport:{width,height:700}});
      await page.setContent(`<style>${fixture.css}\n${read("public/styles/site-experience.css")}</style>${fixture.header}`);
      const result=await page.evaluate(()=>({
        overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        links:[...document.querySelectorAll(".product-nav a")].map(link=>({text:link.textContent.trim(),width:link.getBoundingClientRect().width,height:link.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(link).fontSize)})),
        current:document.querySelector('.product-nav [aria-current="page"]')?.textContent.trim()||null
      }));
      assert.ok(result.overflow<=1,`${fixture.name} navigation overflows ${width}px by ${result.overflow}px`);
      assert.deepEqual(result.links.map(link=>link.text),["Exercises","Strata+","Plan","Train","Account"]);
      assert.ok(result.links.every(link=>link.width>=44&&link.height>=44),`${fixture.name} navigation must keep 44×44px targets at ${width}px`);
      assert.ok(result.links.every(link=>link.fontSize>=11),`${fixture.name} navigation text must remain readable at ${width}px`);
      assert.equal(result.current,fixture.current);
      await page.close();
    }
  }finally{await browser.close();}
});

test("responsive product headers follow their visual keyboard order",{timeout:30_000},async()=>{
  const options={headless:true};
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  const browser=await chromium.launch(options);
  try{
    const fixtures=[
      {
        name:"Strata+",header:headerFrom("public/pages/discover.html"),css:read("public/styles/discover.css"),bodyClass:"plus-studio",
        desktop:["STRATA home","Exercises","Strata+","Plan","Train","Account","Sign out"],
        mobile:["STRATA home","Account","Sign out","Exercises","Strata+","Plan","Train"]
      },
      {
        name:"Plan",header:headerFrom("public/pages/planner.html"),css:read("public/styles/planner.css"),signedIn:true,
        desktop:["STRATA rankings","Exercises","Strata+","Plan","Train","Account","Sign out"],
        mobile:["STRATA rankings","Account","Sign out","Exercises","Strata+","Plan","Train"]
      },
      {
        name:"Train",header:headerFrom("public/pages/workout.html"),css:read("public/styles/workout.css"),
        desktop:["STRATA rankings","Exercises","Strata+","Plan","Train","Account"],
        mobile:["STRATA rankings","Account","Exercises","Strata+","Plan","Train"]
      }
    ];
    for(const fixture of fixtures)for(const [width,expected] of [[1200,fixture.desktop],[390,fixture.mobile],[320,fixture.mobile]]){
      const page=await browser.newPage({viewport:{width,height:800}});
      await page.setContent(`<style>${fixture.css}\n${read("public/styles/site-experience.css")}</style>${fixture.header}`);
      if(fixture.bodyClass)await page.evaluate((bodyClass)=>{document.body.className=bodyClass;},fixture.bodyClass);
      if(fixture.signedIn)await page.evaluate(()=>{document.getElementById("userName").hidden=false;document.getElementById("logoutButton").hidden=false;});
      const result=await page.evaluate(()=>{
        const controls=[...document.querySelectorAll("header a,header button")].filter((control)=>{
          const style=getComputedStyle(control),rect=control.getBoundingClientRect();
          return style.display!=="none"&&style.visibility!=="hidden"&&rect.width>0&&rect.height>0&&!control.disabled;
        });
        controls.forEach((control,index)=>{control.dataset.focusOrder=String(index);});
        document.body.tabIndex=-1;document.body.focus();
        return {
          labels:controls.map((control)=>(control.getAttribute("aria-label")||control.textContent||"").replace(/\s+/g," ").trim()),
          targets:controls.map((control)=>{const rect=control.getBoundingClientRect();return{width:rect.width,height:rect.height};}),
          overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth
        };
      });
      const keyboard=[];
      for(let index=0;index<expected.length;index++){
        await page.keyboard.press("Tab");
        keyboard.push(await page.evaluate(()=>Number(document.activeElement?.dataset.focusOrder)));
      }
      assert.deepEqual(result.labels,expected,`${fixture.name} visible controls must follow visual order at ${width}px`);
      assert.deepEqual(keyboard,expected.map((_,index)=>index),`${fixture.name} Tab order must follow its visible controls at ${width}px`);
      assert.ok(result.targets.every(({width:targetWidth,height})=>targetWidth>=44&&height>=44),`${fixture.name} header targets must remain at least 44×44px at ${width}px`);
      assert.ok(result.overflow<=1,`${fixture.name} header overflows ${width}px by ${result.overflow}px`);
      await page.close();
    }
  }finally{await browser.close();}
});

test("planner cards contain long text and usable controls at every responsive boundary",{timeout:30_000},async()=>{
  const options={headless:true};
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  const browser=await chromium.launch(options),plannerCss=`${read("public/styles/planner.css")}\n${read("public/styles/experience.css")}`;
  const card=(name,score)=>`<article class="library-card"><div class="library-score">${score}</div><div><h3>${name}</h3><p>Shoulders and upper back · Adjustable cable station with handles</p></div><div class="library-actions"><button type="button">Add</button><button class="guide-button" type="button">Guide</button><a class="yt-link" href="#video">Video</a></div></article>`;
  const fixture=`
    <main class="planner-shell">
      <aside class="library-panel">
        <div class="library-heading"><div><p>Exercise library</p><span>Ranked by STRATA FitScore</span></div><strong>200</strong></div>
        <label class="planner-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search all movements"></label>
        <div class="planner-day-picker"><div class="planner-day-picker-heading"><span>Add exercises to</span><strong>Wednesday</strong></div><div class="planner-day-chips">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((day)=>`<button class="planner-day-chip" type="button">${day}</button>`).join("")}</div></div>
        <div class="planner-filters">${["All","Chest","Back","Shoulders","Arms","Legs","Glutes","Calves","Core"].map((group)=>`<button class="planner-filter" type="button">${group}</button>`).join("")}</div>
        <p class="drag-note"><span aria-hidden="true">↗</span><span class="drag-note-compact">Choose a day, select Add, then view my week.</span><span class="drag-note-wide">Choose a quick-add day, then select Add.</span></p>
        <div class="library-list">${card("Behind-body Cable Lateral Raise",95)}${card("Incline Machine Chest Press with Independent Converging Handles",94)}</div>
      </aside>
      <section class="week-section"><div class="week-board"><section class="day-column"><header class="day-head"><div class="day-index"><span>Day 01</span><span>12 movements</span></div><div class="day-title-row"><h2>Wednesday</h2><button class="day-target" type="button">Add here</button></div></header><button class="rest-toggle" type="button">Clear day to make rest</button><div class="day-dropzone"><article class="scheduled-card"><div class="scheduled-card-head"><div><h3>Incline Machine Chest Press with Independent Converging Handles</h3><small>Upper chest · Plate-loaded converging machine</small></div><div class="card-actions"><button type="button">?</button><a href="#tutorial">▶</a><button type="button">×</button></div></div><button class="replace-exercise-button" type="button">Replace exercise</button><div class="prescription"><label>Sets<input type="number" value="3"></label><label>Reps / time<input type="text" value="8–12"></label></div><div class="card-move"><label><span>Day</span><select><option>Wednesday — recovery</option></select></label><div class="move-buttons"><button type="button">↑</button><button type="button">↓</button></div></div></article></div></section></div></section>
    </main>`;
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1210}});
    for(const width of [1440,1024,768,761,760,700,678,600,430,390,360,339,320]){
      await page.setViewportSize({width,height:1210});
      await page.setContent(`<style>${plannerCss}\n${read("public/styles/site-experience.css")}</style>${fixture}`);
      const result=await page.evaluate(()=>{
        const box=(node)=>{const rect=node.getBoundingClientRect();return{top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left,width:rect.width,height:rect.height};};
        const intersects=(left,right)=>left.left<right.right-1&&left.right>right.left+1&&left.top<right.bottom-1&&left.bottom>right.top+1;
        const outside=(child,parent)=>child.left<parent.left-1||child.right>parent.right+1||child.top<parent.top-1||child.bottom>parent.bottom+1;
        const textOutside=(container)=>{
          const parent=box(container),walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT),issues=[];
          for(let node=walker.nextNode();node;node=walker.nextNode()){
            if(!String(node.textContent||"").trim()||node.parentElement?.closest(".sr-only,[aria-hidden='true']"))continue;
            const range=document.createRange();range.selectNodeContents(node);
            if([...range.getClientRects()].some((rect)=>rect.width&&rect.height&&outside(rect,parent)))issues.push(String(node.textContent).trim());
          }
          return issues;
        };
        const cards=[...document.querySelectorAll(".library-card")],heading=box(document.querySelector(".library-heading p")),count=box(document.querySelector(".library-heading strong"));
        const cardIssues=cards.flatMap((card,index)=>{
          const bounds=box(card),copy=box(card.children[1]),actions=box(card.querySelector(".library-actions")),next=cards[index+1];
          return[
            ...(outside(copy,bounds)?[`${index}: copy outside`]:[]),...(outside(actions,bounds)?[`${index}: actions outside`]:[]),
            ...(intersects(copy,actions)?[`${index}: copy/actions overlap`]:[]),...(next&&intersects(bounds,box(next))?[`${index}: next-card overlap`]:[]),
            ...textOutside(card).map((text)=>`${index}: text outside (${text})`)
          ];
        });
        const scheduled=document.querySelector(".scheduled-card"),scheduledBox=box(scheduled),scheduledChildren=[scheduled.querySelector(".scheduled-card-head"),scheduled.querySelector(".card-actions"),...scheduled.querySelectorAll("h3,small,button,a,input,select")].map(box);
        const dayTitle=box(document.querySelector(".day-title-row h2")),dayTarget=box(document.querySelector(".day-target"));
        return{
          overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
          headingCollision:intersects(heading,count),cardIssues,
          listHeight:document.querySelector(".library-list").getBoundingClientRect().height,
          smallPickerTargets:[...document.querySelectorAll(".planner-day-chip,.planner-filter")].filter((control)=>{const rect=control.getBoundingClientRect();return rect.width<44||rect.height<44;}).length,
          smallLibraryTargets:[...document.querySelectorAll(".library-actions>*")].filter((control)=>{const rect=control.getBoundingClientRect();return rect.width<44||rect.height<44;}).length,
          scheduledOutside:scheduledChildren.filter((child)=>outside(child,scheduledBox)).length,
          smallScheduledTargets:[...scheduled.querySelectorAll("button,a,input,select")].filter((control)=>{const rect=control.getBoundingClientRect();return rect.width<44||rect.height<44;}).length,
          dayCollision:intersects(dayTitle,dayTarget)
        };
      });
      assert.ok(result.overflow<=1,`Planner fixture overflows ${width}px by ${result.overflow}px`);
      assert.equal(result.headingCollision,false,`Planner title and result count collide at ${width}px`);
      assert.deepEqual(result.cardIssues,[],`Planner library cards fail containment at ${width}px`);
      assert.ok(result.listHeight>=120,`Planner library leaves only ${result.listHeight}px for results at ${width}px`);
      assert.equal(result.smallPickerTargets,0,`Planner day or filter chips are undersized at ${width}px`);
      assert.equal(result.smallLibraryTargets,0,`Planner library has undersized actions at ${width}px`);
      assert.equal(result.scheduledOutside,0,`Scheduled planner controls leave their card at ${width}px`);
      assert.equal(result.smallScheduledTargets,0,`Scheduled planner card has undersized controls at ${width}px`);
      assert.equal(result.dayCollision,false,`Planner day title and destination control collide at ${width}px`);
    }
    for(const width of [761,768,800,880]){
      await page.setViewportSize({width,height:500});
      await page.setContent(`<style>${plannerCss}\n${read("public/styles/site-experience.css")}</style>${headerFrom("public/pages/planner.html")}`);
      const result=await page.evaluate(()=>{
        document.getElementById("saveStatus").textContent="Couldn't save — Retry";
        document.getElementById("retryPlanSave").hidden=false;
        document.querySelector(".header-center").classList.add("error");
        const box=(node)=>{const rect=node.getBoundingClientRect();return{top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left};},status=box(document.querySelector(".header-center")),nav=box(document.querySelector(".planner-primary-nav-desktop"));
        return{overlap:status.left<nav.right-1&&status.right>nav.left+1&&status.top<nav.bottom-1&&status.bottom>nav.top+1,inside:status.top>=0&&status.right<=innerWidth&&status.bottom<=document.querySelector(".planner-header").getBoundingClientRect().bottom+1};
      });
      assert.equal(result.overlap,false,`Planner save failure overlaps navigation at ${width}px`);
      assert.equal(result.inside,true,`Planner save failure leaves the header at ${width}px`);
    }
    await page.close();
  }finally{await browser.close();}
});
