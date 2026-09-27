"use strict";

const assert=require("node:assert/strict");
const {mkdirSync}=require("node:fs");
const {resolve,join}=require("node:path");
const {chromium}=require("playwright");

const BASE_URL=(process.env.STRATA_QA_BASE_URL||"http://127.0.0.1:4173").replace(/\/+$/,""),BASE_ORIGIN=new URL(BASE_URL).origin;
const ARTIFACT_DIR=process.env.STRATA_QA_ARTIFACT_DIR?resolve(process.env.STRATA_QA_ARTIFACT_DIR):null;
const launchOptions={headless:true};
if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)launchOptions.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);

function isFirstParty(url){try{return new URL(url).origin===BASE_ORIGIN;}catch{return true;}}
function isExpectedGuestAuthConsole(message,pageUrl){
  try{return /Failed to load resource:.*401 \(Unauthorized\)/i.test(message)&&["/","/account.html"].includes(new URL(pageUrl).pathname);}
  catch{return false;}
}
function positive(value,label){assert.ok(value>0,`${label}: expected a positive count, received ${value}`);}

async function chooseOption(control,{values=[],labelPattern}={}){
  await control.waitFor({state:"visible"});
  const options=await control.locator("option").evaluateAll((nodes)=>nodes.map((node)=>({value:node.value,label:(node.textContent||"").trim(),disabled:node.disabled})).filter((option)=>!option.disabled&&option.value));
  const chosen=options.find((option)=>values.includes(option.value))||options.find((option)=>labelPattern?.test(option.label))||options[0];
  assert.ok(chosen,`${await control.getAttribute("id")||"Select"} must offer an enabled choice`);
  await control.selectOption(chosen.value);
  return chosen;
}

async function accessibleName(control){
  return control.evaluate((node)=>{
    const direct=node.getAttribute("aria-label")||"";
    const labelledBy=(node.getAttribute("aria-labelledby")||"").split(/\s+/).filter(Boolean).map((id)=>document.getElementById(id)?.textContent||"").join(" ");
    const labels=Array.from(node.labels||[]).map((label)=>label.textContent||"").join(" ");
    return `${direct} ${labelledBy} ${labels} ${node.textContent||""}`.replace(/\s+/g," ").trim();
  });
}

async function horizontalOverflow(page){
  return page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth));
}

async function textOutsideContainers(page,selector){
  return page.locator(selector).evaluateAll((containers)=>containers.flatMap((container,index)=>{
    const bounds=container.getBoundingClientRect(),issues=[];
    if(bounds.width<=0||bounds.height<=0||getComputedStyle(container).visibility==="hidden")return issues;
    const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
    for(let textNode=walker.nextNode();textNode;textNode=walker.nextNode()){
      const text=String(textNode.textContent||"").replace(/\s+/g," ").trim(),parent=textNode.parentElement;
      if(!text||!parent||parent.closest(".sr-only,[hidden],[aria-hidden='true']"))continue;
      const style=getComputedStyle(parent);
      if(style.display==="none"||style.visibility==="hidden"||Number(style.opacity)===0)continue;
      const range=document.createRange();range.selectNodeContents(textNode);
      for(const rect of range.getClientRects()){
        if(rect.width<=0||rect.height<=0)continue;
        if(rect.left<bounds.left-2||rect.right>bounds.right+2||rect.top<bounds.top-2||rect.bottom>bounds.bottom+2){
          issues.push(`${index}:${text.slice(0,48)}`);break;
        }
      }
    }
    return issues;
  }));
}

async function plannerLibraryLayoutIssues(page){
  return page.locator(".library-card").evaluateAll((cards)=>cards.flatMap((card,index)=>{
    const box=(node)=>{const rect=node.getBoundingClientRect();return{top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left,width:rect.width,height:rect.height};};
    const cardBox=box(card),copy=card.children[1],actions=card.querySelector(".library-actions"),copyBox=copy?box(copy):null,actionsBox=actions?box(actions):null,issues=[];
    if(copyBox&&actionsBox&&copyBox.top<actionsBox.bottom-1&&copyBox.bottom>actionsBox.top+1&&copyBox.left<actionsBox.right-1&&copyBox.right>actionsBox.left+1)issues.push(`${index}:copy overlaps actions`);
    if(copyBox&&(copyBox.top<cardBox.top-1||copyBox.bottom>cardBox.bottom+1))issues.push(`${index}:copy leaves card`);
    if(actionsBox&&(actionsBox.top<cardBox.top-1||actionsBox.bottom>cardBox.bottom+1))issues.push(`${index}:actions leave card`);
    const next=cards[index+1];if(next&&cardBox.bottom>box(next).top+1)issues.push(`${index}:card overlaps next card`);
    return issues;
  }));
}

async function contrastRatio(locator){
  return locator.evaluate((node)=>{
    const rgba=(value)=>{
      const parts=String(value).match(/[\d.]+/g)?.map(Number)||[];
      return[parts[0]||0,parts[1]||0,parts[2]||0,parts.length>3?parts[3]:1];
    };
    const over=(top,bottom)=>{
      const alpha=top[3]+bottom[3]*(1-top[3]);
      return[0,1,2].map((index)=>(top[index]*top[3]+bottom[index]*bottom[3]*(1-top[3]))/alpha).concat(alpha);
    };
    const layers=[];
    for(let current=node;current;current=current.parentElement)layers.push(rgba(getComputedStyle(current).backgroundColor));
    let background=[255,255,255,1];
    for(let index=layers.length-1;index>=0;index-=1)background=over(layers[index],background);
    const foreground=over(rgba(getComputedStyle(node).color),background);
    const luminance=(color)=>{
      const channels=color.slice(0,3).map((part)=>{const value=part/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});
      return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
    };
    const values=[luminance(foreground),luminance(background)].sort((left,right)=>right-left);
    return (values[0]+.05)/(values[1]+.05);
  });
}

async function savedPlanCount(page){
  return page.evaluate(async()=>{
    const response=await fetch("/api/plan",{credentials:"same-origin",headers:{Accept:"application/json"}});
    if(!response.ok)throw new Error(`Plan read failed with HTTP ${response.status}`);
    const data=await response.json(),days=data.plan?.days||{};
    return Object.values(days).reduce((total,items)=>total+(Array.isArray(items)?items.length:0),0);
  });
}

async function clearSavedPlan(page){
  return page.evaluate(async()=>{
    const [planResponse,discoveryResponse]=await Promise.all([fetch("/api/plan",{credentials:"same-origin",headers:{Accept:"application/json"}}),fetch("/api/discovery",{credentials:"same-origin",headers:{Accept:"application/json"}})]);
    if(!planResponse.ok||!discoveryResponse.ok)throw new Error(`Plan reset prerequisites failed with HTTP ${planResponse.status}/${discoveryResponse.status}`);
    const planData=await planResponse.json(),discovery=await discoveryResponse.json(),days=Object.fromEntries(Object.keys(planData.plan?.days||{}).map((day)=>[day,[]]));
    const response=await fetch("/api/plan",{method:"PUT",credentials:"same-origin",headers:{Accept:"application/json","Content-Type":"application/json","X-CSRF-Token":discovery.csrfToken},body:JSON.stringify({plan:{...planData.plan,days},expectedPlanUpdatedAt:planData.planUpdatedAt})});
    if(!response.ok)throw new Error(`Plan reset failed with HTTP ${response.status}`);
    return response.json();
  });
}

async function capture(page,name,options={}){
  if(!ARTIFACT_DIR)return;
  mkdirSync(ARTIFACT_DIR,{recursive:true});
  await page.screenshot({path:join(ARTIFACT_DIR,name),...options});
}

let browser;
(async()=>{
  try{
    browser=await chromium.launch(launchOptions);
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on("console",message=>{const location=message.location(),text=message.text();if(message.type()==="error"&&(!location.url||isFirstParty(location.url))&&!isExpectedGuestAuthConsole(text,page.url()))errors.push(`console at ${new URL(page.url()).pathname}: ${text}`);});
    page.on("pageerror",error=>errors.push(`page: ${error.stack||error.message}`));
    page.on("requestfailed",request=>{if(isFirstParty(request.url()))errors.push(`request: ${request.url()} ${request.failure()?.errorText||"failed"}`);});

    await page.goto(`${BASE_URL}/`,{waitUntil:"networkidle"});
    const publicHeaderLinks=await page.locator(".desktop-nav a").evaluateAll((nodes)=>nodes.map((node)=>[node.getAttribute("href"),node.textContent.trim()]));
    assert.deepEqual(publicHeaderLinks,[["#rankings","Exercises"],["/discover.html","Strata+"],["/planner.html","Plan"],["/workout.html","Train"]],"Homepage desktop navigation must match the four product destinations used everywhere else");
    assert.match((await page.locator(".discovery-offer").textContent())||"",/7 days[\s\S]*\$2\.99 USD per month[\s\S]*renews monthly until canceled/i);
    for(const [label,control] of [["homepage primary action",page.locator(".hero .button-accent").first()]]){
      const ratio=await contrastRatio(control);assert.ok(ratio>=4.5,`${label} text contrast is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
    }
    const publicDetailTrigger=page.locator("[data-detail]").first(),publicDetailDialog=page.locator("#detailDialog");
    await publicDetailTrigger.waitFor({state:"visible"});await publicDetailTrigger.focus();await page.keyboard.press("Enter");await publicDetailDialog.waitFor({state:"visible"});
    assert.equal(await publicDetailDialog.getAttribute("aria-labelledby"),"detailTitle","Homepage exercise details need an explicit dialog label");
    assert.equal(await publicDetailDialog.evaluate((dialog)=>dialog.contains(document.activeElement)),true,"Opening homepage details must move keyboard focus into the dialog");
    await page.keyboard.press("Escape");await publicDetailDialog.waitFor({state:"hidden"});
    assert.equal(await publicDetailTrigger.evaluate((trigger)=>trigger===document.activeElement),true,"Closing homepage details must return focus to its trigger");
    await Promise.all([page.waitForURL(url=>url.pathname.endsWith("/account.html")),page.click("#signupButton")]);
    await page.fill('#signupPanel input[name="name"]',"UI Audit Member With A Long Display Name");
    await page.fill('#signupPanel input[name="email"]',`audit-${Date.now()}-${process.pid}@example.test`);
    await page.fill('#signupPanel input[name="password"]',"audit-password-123");
    await Promise.all([page.waitForURL(url=>url.pathname.endsWith("/planner.html")),page.click('#signupPanel button[type="submit"]')]);
    const snapshot={signupDestination:page.url(),title:await page.title(),publicDialogKeyboard:true};
    assert.equal(new URL(snapshot.signupDestination).pathname,"/planner.html","A new unpaid account should land on the free planner");
    assert.match(snapshot.title,/STRATA/i);

    await page.goto(`${BASE_URL}/account.html`,{waitUntil:"networkidle"});
    await page.locator("#signedInCard").waitFor({state:"visible"});
    assert.equal(await page.locator("#accountAdminAction").isHidden(),true,"A non-admin account must not render the administrator action");
    assert.equal(await page.locator("#accountDeleteCancel").isHidden(),true,"An account without a pending deletion must not render its cancellation action");
    assert.equal(new URL(await page.locator("#accountPrimaryAction").getAttribute("href"),BASE_URL).pathname,"/planner.html","A planless free account should return to the free planner");
    await capture(page,"account-signed-in-desktop.png",{fullPage:true});

    await page.goto(`${BASE_URL}/planner.html`,{waitUntil:"networkidle"});
    await page.locator(".library-card").first().waitFor();
    snapshot.plannerCards=await page.locator(".library-card").count();
    positive(snapshot.plannerCards,"Planner library cards");
    if(await page.locator("[data-load-more-library]").count()){
      await page.locator("[data-load-more-library]").click();
      snapshot.plannerCardsAfterLoadMore=await page.locator(".library-card").count();
      assert.ok(snapshot.plannerCardsAfterLoadMore>snapshot.plannerCards,"Planner load-more must reveal additional cards");
    }
    const [planResponse]=await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).pathname==="/api/plan"&&response.request().method()==="PUT"),
      page.locator('[data-quick-add="flat-dumbbell-press"]').click()
    ]);
    assert.ok(planResponse.ok(),`Planner save failed with HTTP ${planResponse.status()}`);
    snapshot.scheduled=await page.locator(".scheduled-card").count();
    positive(snapshot.scheduled,"Scheduled planner cards");
    snapshot.plannerResponsive={};
    for(const width of [1440,1024,768,761,760,700,600,430,390,360,339,320]){
      await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts?.ready);
      const [layoutIssues,textIssues,overflow]=await Promise.all([plannerLibraryLayoutIssues(page),textOutsideContainers(page,".library-card"),horizontalOverflow(page)]);
      snapshot.plannerResponsive[width]={layoutIssues:layoutIssues.length,textIssues:textIssues.length,overflow};
      assert.deepEqual(layoutIssues,[],`Planner library geometry issues at ${width}px: ${layoutIssues.join(", ")}`);
      assert.deepEqual(textIssues,[],`Planner library text outside its card at ${width}px: ${textIssues.join(", ")}`);
      assert.ok(overflow<=1,`Planner overflows horizontally by ${overflow}px at ${width}px`);
      if(width===339)await capture(page,"planner-library-339.png",{fullPage:false});
    }
    await page.setViewportSize({width:1440,height:1000});

    await page.goto(`${BASE_URL}/pricing`,{waitUntil:"networkidle"});
    await page.locator("#purchaseStatus").waitFor();
    snapshot.checkoutStatus=((await page.locator("#purchaseStatus").textContent())||"").trim();
    snapshot.trialVisible=await page.locator("#trialDiscovery").isVisible();
    snapshot.buyVisible=await page.locator("#buyDiscovery").isVisible();
    assert.equal(snapshot.trialVisible,true,"An eligible signed-in account should see the no-card trial as its one primary start");
    assert.equal(snapshot.buyVisible,false,"Checkout must not compete with the eligible account's trial action");
    assert.match(snapshot.checkoutStatus,/eligible for one free|temporarily unavailable|not configured correctly/i,"Pricing must explain either the available no-card trial or the disabled checkout state");
    await capture(page,"pricing-locked-desktop.png",{fullPage:true});

    await page.goto(`${BASE_URL}/discover.html`,{waitUntil:"networkidle"});
    const lockedUrl=new URL(page.url());
    snapshot.lockedDiscoveryUrl=page.url();
    assert.equal(lockedUrl.pathname,"/pricing");
    assert.equal(lockedUrl.searchParams.get("reason"),"discovery-required");

    await page.setViewportSize({width:390,height:844});
    await page.goto(`${BASE_URL}/`,{waitUntil:"networkidle"});
    const mobilePublicLinks=await page.locator(".mobile-public-nav a").evaluateAll((nodes)=>nodes.map((node)=>[node.getAttribute("href"),node.textContent.trim()]));
    assert.deepEqual(mobilePublicLinks,[["#rankings","Exercises"],["/discover.html","Strata+"],["/planner.html","Plan"],["/workout.html","Train"]],"Mobile homepage navigation must keep the four primary product destinations");
    assert.equal(await page.locator('.footer-links a[href="/policies"]').count(),1,"Mobile homepage footer must expose one Policies destination");
    assert.equal(await page.locator('.footer-links a:is([href="/terms"],[href="/privacy"],[href="/refunds"])').count(),0,"Homepage footer must not duplicate policy-directory links");
    const smallPublicTargets=await page.locator(".mobile-public-nav a").evaluateAll((nodes)=>nodes.filter((node)=>{const rect=node.getBoundingClientRect();return rect.width<44||rect.height<44;}).map((node)=>node.textContent.trim()));
    assert.deepEqual(smallPublicTargets,[],`Homepage public links below 44px: ${smallPublicTargets.join(", ")}`);
    assert.equal(await page.locator("#founder").count(),0,"Founder biography must not clutter the homepage");
    await page.goto(`${BASE_URL}/policies#founder`,{waitUntil:"networkidle"});
    assert.equal(await page.locator("#founder").isVisible(),true,"Founder section must render on the public policies page");
    await page.locator("#founder").scrollIntoViewIfNeeded();
    await capture(page,"founder-mobile.png",{fullPage:false});
    await page.goto(`${BASE_URL}/discover.html`,{waitUntil:"networkidle"});
    assert.equal(new URL(page.url()).pathname,"/pricing","Unpaid mobile users must remain behind the Strata+ paywall");
    snapshot.mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
    assert.ok(snapshot.mobileOverflow<=1,`Mobile layout overflows horizontally by ${snapshot.mobileOverflow}px`);
    await capture(page,"pricing-locked-mobile.png",{fullPage:true});

    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${BASE_URL}/pricing`,{waitUntil:"networkidle"});
    const trialButton=page.locator("#trialDiscovery");
    await trialButton.waitFor({state:"visible"});
    assert.equal(await trialButton.isDisabled(),false,"An eligible account must be able to start its single free trial without Paddle checkout");
    const [trialResponse]=await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).pathname==="/api/discovery/trial"&&response.request().method()==="POST"),
      trialButton.click()
    ]);
    assert.ok(trialResponse.ok(),`Trial activation failed with HTTP ${trialResponse.status()}`);
    assert.ok([200,201].includes(trialResponse.status()),`Trial activation returned unexpected HTTP ${trialResponse.status()}`);
    await page.locator("#openDiscovery").waitFor({state:"visible"});
    snapshot.trialStatus=((await page.locator("#purchaseStatus").textContent())||"").trim();
    assert.match(snapshot.trialStatus,/free Strata\+ trial is active/i,"Pricing must confirm the active 7-day trial");
    await Promise.all([
      page.waitForURL(url=>url.pathname.endsWith("/discover.html")),
      page.locator("#openDiscovery").click()
    ]);
    await page.waitForLoadState("networkidle");

    assert.equal(new URL(page.url()).hash,"","Opening Strata+ without a tool hash must keep a clean URL");
    assert.ok(await page.evaluate(()=>scrollY<=1),"Opening Strata+ without a tool hash must stay at the top of the page");
    assert.match(((await page.locator("#todayTitle").textContent())||"").replace(/\s+/g," ").trim(),/^ONE SESSION\.\s*ONE CLEAR NEXT STEP\.$/,"Today must open with one clear action");
    const todayContrast=await contrastRatio(page.locator("#todayTitle"));
    assert.ok(todayContrast>=4.5,`Today title contrast is ${todayContrast.toFixed(2)}:1; expected at least 4.5:1`);
    const primaryWorkout=page.getByRole("link",{name:"Start workout",exact:true}),pulseAction=page.getByRole("link",{name:"Review plan",exact:true});
    await primaryWorkout.waitFor({state:"visible"});await pulseAction.waitFor({state:"visible"});
    const primaryWorkoutUrl=new URL(await primaryWorkout.getAttribute("href"),BASE_URL),pulseDay=await page.locator("#weeklyPulse").getAttribute("data-session-day");
    assert.equal(primaryWorkoutUrl.pathname,"/workout.html");assert.equal(primaryWorkoutUrl.searchParams.get("day"),pulseDay,"The workout CTA must link to the next scheduled day shown in the pulse");
    assert.equal(new URL(await pulseAction.getAttribute("href"),BASE_URL).hash,"#planWorkspace","The pulse action must open the Plan destination");
    const destinationWidths=await page.locator(".destination-link").evaluateAll((nodes)=>nodes.map((node)=>node.getBoundingClientRect().width));
    assert.ok(Math.max(...destinationWidths)-Math.min(...destinationWidths)<=1,"Today, Plan, Progress, and Explore must have equal navigation widths");
    snapshot.todayOverflow=await horizontalOverflow(page);assert.ok(snapshot.todayOverflow<=1,`Today overflows desktop by ${snapshot.todayOverflow}px`);
    const smallDestinations=await page.locator(".destination-link").evaluateAll((nodes)=>nodes.filter((node)=>{const rect=node.getBoundingClientRect();return rect.width<44||rect.height<44;}).map((node)=>node.textContent.trim()));
    assert.deepEqual(smallDestinations,[],"Every Strata+ destination needs a 44px keyboard and touch target");
    await capture(page,"strata-plus-today-desktop.png",{fullPage:false});
    await page.setViewportSize({width:390,height:844});await capture(page,"strata-plus-today-mobile.png",{fullPage:false});
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.destination-link[data-feature-target="plan"]').click();await page.locator("#planWorkspace").waitFor({state:"visible"});
    assert.equal(new URL(page.url()).hash,"#planWorkspace");await page.waitForFunction(()=>document.activeElement?.id==="planWorkspaceTitle");
    assert.equal(await page.locator("#planAheadDetails").evaluate((node)=>node.open),false,"Secondary planning tools should start collapsed");
    await page.locator("#planAheadDetails > summary").click();
    const expectedLocalDate=await page.evaluate(()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;});
    assert.equal(await page.locator("#trainingBlockStartDate").inputValue(),expectedLocalDate,"A new block should suggest today's editable local date");
    const [blockResponse]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==="/api/training-block"&&response.request().method()==="PUT"),page.locator("#trainingBlockSave").click()]);
    assert.ok(blockResponse.ok(),`Training block save failed with HTTP ${blockResponse.status()}`);await page.waitForFunction(()=>/^Saved\. Active · date-derived week 1 of 6/i.test(document.querySelector("#trainingBlockStatus")?.textContent||""));
    await capture(page,"strata-plus-plan-desktop.png",{fullPage:false});
    await page.setViewportSize({width:390,height:844});await capture(page,"strata-plus-plan-mobile.png",{fullPage:false});
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.destination-link[data-feature-target="progress"]').click();await page.locator("#progressWorkspace").waitFor({state:"visible"});
    assert.equal(new URL(page.url()).hash,"#progressWorkspace");assert.equal(await page.locator(".progress-metric-grid article").count(),4,"Progress must keep its four bounded log-derived summaries");
    assert.match((await page.locator("#progressWorkspace").textContent())||"",/training records, not a health assessment/i);
    await page.waitForTimeout(550);
    await capture(page,"strata-plus-progress-desktop.png",{fullPage:false});
    await page.setViewportSize({width:390,height:844});await capture(page,"strata-plus-progress-mobile.png",{fullPage:false});
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.destination-link[data-feature-target="explore"]').click();
    await page.locator('.feature-block[data-feature-target="recommendations"]').click();
    await page.locator("#recommendationTitle").waitFor({state:"visible"});
    assert.equal(((await page.locator("#recommendationTitle").textContent())||"").replace(/\s+/g," ").trim(),"Best exercises for you.","Recommendation heading must not depend on a member's display name");
    const recommendationContrast=await contrastRatio(page.locator("#recommendationTitle"));
    assert.ok(recommendationContrast>=4.5,`Recommendation title contrast is ${recommendationContrast.toFixed(2)}:1; expected at least 4.5:1`);
    await page.locator('#recommendationGrid [data-toggle-shortlist]').first().click();
    await page.waitForFunction(()=>document.querySelector("#movementBoardCapacity")?.textContent?.trim()==="1 / 4 saved");
    snapshot.decisionBoardStorageKey=await page.evaluate(()=>Object.keys(localStorage).find((key)=>key.startsWith("strata_plus_movement_board_v1:"))||"");
    assert.match(snapshot.decisionBoardStorageKey,/^strata_plus_movement_board_v1:.+/,"The decision board must use an account-keyed browser-storage record");
    await page.reload({waitUntil:"networkidle"});
    await page.waitForFunction(()=>document.querySelector("#movementBoardCapacity")?.textContent?.trim()==="1 / 4 saved");
    await page.locator('#recommendationGrid [data-toggle-shortlist]').nth(1).click();
    await page.waitForFunction(()=>document.querySelector("#movementBoardCapacity")?.textContent?.trim()==="2 / 4 saved");
    assert.equal(await page.locator("#compareMovementBoard").isEnabled(),true,"Two saved movements must enable the comparison handoff");
    await page.locator("#compareMovementBoard").click();
    await page.locator("#battleResults").waitFor({state:"visible"});
    assert.equal(new URL(page.url()).hash,"#battle","The decision board must open the existing comparison workspace");
    await page.goto(`${BASE_URL}/discover.html#recommendations`,{waitUntil:"networkidle"});
    await page.locator("#clearMovementBoard").click();
    assert.equal(((await page.locator("#movementBoardCapacity").textContent())||"").trim(),"0 / 4 saved","Clearing the decision board must update its visible state");
    await page.waitForTimeout(550);
    await capture(page,"strata-plus-recommendations-desktop.png",{fullPage:false});

    await page.setViewportSize({width:390,height:844});
    await page.goto(`${BASE_URL}/discover.html#recommendations`,{waitUntil:"networkidle"});
    await page.waitForTimeout(550);
    await capture(page,"strata-plus-recommendations-top-mobile.png",{fullPage:false});
    await page.locator("#recommendationTitle").evaluate((node)=>window.scrollTo(0,node.getBoundingClientRect().top+window.scrollY-document.querySelector(".studio-header").getBoundingClientRect().height-20));
    await page.waitForTimeout(550);
    assert.equal(await page.locator(".studio-header .brand").isVisible(),true,"The Strata+ brand must remain visible after scrolling to a tool");
    assert.equal(await page.locator(".studio-header .studio-account").isVisible(),true,"The Strata+ account action must remain visible after scrolling to a tool");
    await capture(page,"strata-plus-recommendations-mobile.png",{fullPage:false});
    await page.goto(`${BASE_URL}/discover.html#profile`,{waitUntil:"networkidle"});
    await page.locator("#profile").waitFor({state:"visible"});
    await page.waitForFunction(()=>document.querySelector("#profileStatus")?.textContent?.trim()==="Saved");
    await page.locator("#profileTitle").evaluate((node)=>window.scrollTo({top:node.getBoundingClientRect().top+window.scrollY-document.querySelector(".studio-header").getBoundingClientRect().height-20,behavior:"instant"}));
    await page.waitForTimeout(550);
    const profileHeaderLayout=await page.locator(".studio-header").evaluate((header)=>{
      const box=(node)=>{const rect=node.getBoundingClientRect();return{top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left,width:rect.width,height:rect.height};};
      const visibleChild=(selector)=>{const node=header.querySelector(selector),rect=node.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return{box:box(node),visible:getComputedStyle(node).visibility==="visible"&&Number(getComputedStyle(node).opacity)>0,uncovered:node===hit||node.contains(hit)};};
      const backgroundParts=String(getComputedStyle(header).backgroundColor).match(/[\d.]+/g)?.map(Number)||[];
      return{header:box(header),brand:visibleChild(".brand"),account:visibleChild(".studio-account"),logout:visibleChild("#logoutButton"),backgroundAlpha:backgroundParts.length>3?backgroundParts[3]:1};
    });
    assert.ok(profileHeaderLayout.header.top>=-1&&profileHeaderLayout.header.bottom>=64,"The Strata+ mobile header must remain fully visible while using a tool");
    assert.equal(profileHeaderLayout.backgroundAlpha,1,"The mobile Strata+ header must be opaque so scrolled workspace labels cannot show through it");
    for(const [name,item] of Object.entries({brand:profileHeaderLayout.brand,account:profileHeaderLayout.account,logout:profileHeaderLayout.logout})){
      assert.ok(item.visible&&item.uncovered&&item.box.top>=0&&item.box.bottom<=profileHeaderLayout.header.bottom+1,`The Strata+ ${name} control must remain visible and unobscured in profile settings`);
    }
    const profileTitleContrast=await contrastRatio(page.locator("#profileTitle"));
    assert.ok(profileTitleContrast>=4.5,`Profile title contrast is ${profileTitleContrast.toFixed(2)}:1; expected at least 4.5:1 after its entrance animation`);
    await capture(page,"strata-plus-profile-mobile.png",{fullPage:false});

    await page.setViewportSize({width:700,height:900});
    const headerLayout=await page.locator(".studio-header").evaluate((header)=>{const nav=header.querySelector(".studio-nav-mobile"),brand=header.querySelector(".brand"),user=header.querySelector(".studio-user"),box=(node)=>{const rect=node.getBoundingClientRect();return{top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left,width:rect.width,height:rect.height};};return{header:box(header),nav:box(nav),brand:box(brand),user:box(user),navPosition:getComputedStyle(nav).position,viewport:innerWidth,viewportHeight:innerHeight,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
    assert.equal(headerLayout.navPosition,"fixed","At 700px, Strata+ navigation must use the same bottom-bar layout as Plan and Train");
    assert.ok(Math.abs(headerLayout.nav.bottom-headerLayout.viewportHeight)<=1,"At 700px, Strata+ navigation must stay at the viewport bottom");
    assert.ok(headerLayout.nav.left>=0&&headerLayout.nav.right<=headerLayout.viewport+1&&headerLayout.overflow<=1,"At 700px, the header and navigation must remain inside the viewport");
    assert.ok(headerLayout.header.height<=80,`At 700px, the header is unexpectedly tall at ${headerLayout.header.height}px`);
    for(const [route,selector,label] of [["/planner.html",".planner-primary-nav-mobile","Planner"],["/workout.html?day=Monday",".workout-nav-mobile","Workout"]]){
      await page.goto(`${BASE_URL}${route}`,{waitUntil:"networkidle"});
      const layout=await page.locator(selector).evaluate((node)=>{const rect=node.getBoundingClientRect();return{bottom:rect.bottom,position:getComputedStyle(node).position,viewport:innerHeight,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
      assert.equal(layout.position,"fixed",`${label} navigation must use the shared bottom bar at 700px`);
      assert.ok(Math.abs(layout.viewport-layout.bottom)<=1,`${label} navigation must stay at the viewport bottom at 700px`);
      assert.ok(layout.overflow<=1,`${label} must not overflow horizontally at 700px`);
    }
    await page.setViewportSize({width:1440,height:1000});

    await clearSavedPlan(page);await page.goto(`${BASE_URL}/discover.html`,{waitUntil:"networkidle"});
    const firstWeekAction=page.getByRole("link",{name:"Build your first week",exact:true});
    await firstWeekAction.waitFor({state:"visible"});assert.equal(new URL(await firstWeekAction.getAttribute("href"),BASE_URL).pathname,"/planner.html");
    assert.equal(await page.locator("#plusRoutineAction").count(),0,"The hero must not duplicate the weekly pulse's planning action");
    assert.equal(await page.locator("#weeklyPulseFooter").isHidden(),true,"A planless account must not be offered Review plan");

    await page.goto(`${BASE_URL}/discover.html#profile`,{waitUntil:"networkidle"});
    assert.equal(new URL(page.url()).hash,"#profile","A direct Strata+ tool hash must be preserved");
    await page.locator("#profile").waitFor({state:"visible"});
    await page.goto(`${BASE_URL}/discover.html`,{waitUntil:"networkidle"});
    assert.equal(new URL(page.url()).hash,"","Returning to plain Strata+ must not inject a default hash");
    assert.ok(await page.evaluate(()=>scrollY<=1),"Returning to plain Strata+ must stay at the top");

    const sessionBuilder=page.locator("#sessionBuilder"),sessionGroup=page.locator("#sessionGroup"),sessionLength=page.locator("#sessionLength"),sessionDay=page.locator("#sessionDay"),sessionGenerate=page.locator("#sessionGenerate"),sessionResults=page.locator("#sessionResults"),sessionStatus=page.locator("#sessionStatus"),sessionAddAll=page.locator("#sessionAddAll");
    await page.locator('.destination-link[data-feature-target="plan"]').click();await page.locator("#workoutBuilderDetails > summary").click();
    const sessionFeature=page.locator('#workoutBuilderDetails [data-feature-target="session"]');
    await sessionFeature.waitFor({state:"visible"});
    await sessionFeature.focus();
    await page.keyboard.press("Enter");
    await sessionBuilder.waitFor({state:"visible"});
    assert.equal(new URL(page.url()).hash,"#sessionBuilder","Session Builder navigation must preserve a shareable workspace URL");
    for(const control of [sessionGroup,sessionLength,sessionDay,sessionGenerate]){
      await control.waitFor({state:"visible"});
      positive((await accessibleName(control)).length,`${await control.getAttribute("id")} accessible name`);
    }
    const builderLabel=await sessionBuilder.getAttribute("aria-label"),builderLabelledBy=await sessionBuilder.getAttribute("aria-labelledby");
    assert.ok(builderLabel||builderLabelledBy,"Session Builder must expose an accessible section name");
    assert.ok(["status","alert"].includes((await sessionStatus.getAttribute("role"))||""),"Session Builder status must be announced");
    assert.ok(["polite","assertive"].includes((await sessionStatus.getAttribute("aria-live"))||""),"Session Builder status must use an aria-live region");
    assert.equal(await sessionAddAll.isHidden(),true,"Session plan action must stay hidden until the member explicitly builds a session");
    assert.match(((await sessionResults.textContent())||""),/your session will appear here/i);
    snapshot.contrast={sessionStatus:await contrastRatio(sessionStatus),sessionAction:await contrastRatio(sessionGenerate)};
    assert.ok(snapshot.contrast.sessionStatus>=4.5,`Session status text contrast is ${snapshot.contrast.sessionStatus.toFixed(2)}:1; expected at least 4.5:1`);
    assert.ok(snapshot.contrast.sessionAction>=4.5,`Session action text contrast is ${snapshot.contrast.sessionAction.toFixed(2)}:1; expected at least 4.5:1`);

    snapshot.sessionChoices={
      group:await chooseOption(sessionGroup,{values:["full"],labelPattern:/full body/i}),
      length:await chooseOption(sessionLength,{values:["20"],labelPattern:/20/i}),
      day:await chooseOption(sessionDay,{values:["Tuesday"],labelPattern:/Tuesday/i})
    };
    assert.equal(await sessionAddAll.isHidden(),true,"Changing the session brief must not generate a hidden session automatically");
    const planCountBeforeSession=await savedPlanCount(page);
    await sessionGenerate.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await sessionGenerate.evaluate((node)=>node===document.activeElement),true,"Session generation must remain keyboard reachable");
    const focusTreatment=await sessionGenerate.evaluate((node)=>{const style=getComputedStyle(node);return {outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth)||0,boxShadow:style.boxShadow};});
    assert.ok((focusTreatment.outlineStyle!=="none"&&focusTreatment.outlineWidth>=2)||focusTreatment.boxShadow!=="none","Session generation needs a visible keyboard focus treatment");
    await page.keyboard.press("Enter");
    await sessionResults.waitFor({state:"visible"});
    await sessionAddAll.waitFor({state:"visible"});
    snapshot.sessionGeneratedText=((await sessionResults.textContent())||"").replace(/\s+/g," ").trim();
    positive(snapshot.sessionGeneratedText.length,"Generated session content");
    assert.match(((await sessionStatus.textContent())||""),/ready|generated|exercise|session/i,"Session Builder must announce successful generation");
    const sessionDetailTrigger=sessionResults.locator("[data-open-detail]").first(),sessionDetailDialog=page.locator("#detailDialog");
    await sessionDetailTrigger.focus();await page.keyboard.press("Enter");await sessionDetailDialog.waitFor({state:"visible"});
    assert.equal(await sessionDetailDialog.getAttribute("aria-labelledby"),"detailTitle","Strata+ exercise details need an explicit dialog label");
    assert.equal(await sessionDetailDialog.evaluate((dialog)=>dialog.contains(document.activeElement)),true,"Opening Strata+ details must move keyboard focus into the dialog");
    const detailSave=sessionDetailDialog.locator("[data-toggle-shortlist]");
    await detailSave.focus();await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector("#detailDialog [data-toggle-shortlist]")===document.activeElement);
    assert.equal(await sessionDetailDialog.locator("[data-toggle-shortlist]").getAttribute("aria-pressed"),"true","Saving from exercise details must update the replacement control and restore its keyboard focus");
    await page.keyboard.press("Escape");await sessionDetailDialog.waitFor({state:"hidden"});
    assert.equal(await sessionDetailTrigger.evaluate((trigger)=>trigger===document.activeElement),true,"Closing Strata+ details must return focus to its trigger");
    snapshot.sessionDialogKeyboard=true;
    snapshot.sessionDesktopOverflow=await horizontalOverflow(page);
    assert.ok(snapshot.sessionDesktopOverflow<=1,`Generated Session Builder overflows desktop by ${snapshot.sessionDesktopOverflow}px`);
    await sessionBuilder.scrollIntoViewIfNeeded();
    await capture(page,"session-builder-desktop.png",{fullPage:false});

    await page.setViewportSize({width:390,height:844});
    await page.locator("#sessionResultsTitle").evaluate((node)=>window.scrollTo(0,node.getBoundingClientRect().top+window.scrollY-document.querySelector(".studio-header").getBoundingClientRect().height-20));
    snapshot.sessionMobileOverflow=await horizontalOverflow(page);
    assert.ok(snapshot.sessionMobileOverflow<=1,`Generated Session Builder overflows mobile by ${snapshot.sessionMobileOverflow}px`);
    const mobileResultsTitle=await page.locator("#sessionResultsTitle").boundingBox();
    assert.ok(mobileResultsTitle&&mobileResultsTitle.y>=60&&mobileResultsTitle.y<844,"Generated session results must enter the mobile viewport");
    await capture(page,"session-builder-mobile.png",{fullPage:false});

    await page.setViewportSize({width:320,height:700});
    await sessionBuilder.scrollIntoViewIfNeeded();
    snapshot.sessionNarrowOverflow=await horizontalOverflow(page);
    assert.ok(snapshot.sessionNarrowOverflow<=1,`Generated Session Builder overflows a 320px viewport by ${snapshot.sessionNarrowOverflow}px`);
    const smallSessionTargets=await sessionBuilder.locator("a,button,select").evaluateAll((nodes)=>nodes.filter((node)=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return style.display!=="none"&&style.visibility!=="hidden"&&!node.hidden&&(rect.width<44||rect.height<44);}).map((node)=>node.id||(node.textContent||"").trim()));
    assert.deepEqual(smallSessionTargets,[],`Session Builder controls below 44px: ${smallSessionTargets.join(", ")}`);
    await capture(page,"session-builder-mobile-320.png",{fullPage:false});

    await page.setViewportSize({width:1440,height:1000});
    await sessionBuilder.scrollIntoViewIfNeeded();
    const generatedStatusBeforeSave=((await sessionStatus.textContent())||"").trim();
    const [addAllResponse]=await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).pathname==="/api/plan"&&response.request().method()==="PUT"),
      sessionAddAll.click()
    ]);
    assert.ok(addAllResponse.ok(),`Adding the generated session failed with HTTP ${addAllResponse.status()}`);
    const addAllPayload=addAllResponse.request().postDataJSON();
    assert.ok(addAllPayload?.plan?.days&&Number.isSafeInteger(addAllPayload.expectedPlanUpdatedAt),"Add-all must use the versioned saved-plan contract");
    await page.waitForFunction((before)=>{const text=(document.querySelector("#sessionStatus")?.textContent||"").trim();return Boolean(text)&&text!==before&&!/saving|adding/i.test(text);},generatedStatusBeforeSave);
    const planCountAfterSession=await savedPlanCount(page);
    assert.ok(planCountAfterSession>planCountBeforeSession,`Add-all must persist exercises (${planCountBeforeSession} before, ${planCountAfterSession} after)`);
    snapshot.sessionPlanCounts={before:planCountBeforeSession,after:planCountAfterSession};
    snapshot.sessionSavedStatus=((await sessionStatus.textContent())||"").replace(/\s+/g," ").trim();
    assert.match(snapshot.sessionSavedStatus,/added|saved|plan/i,"Session Builder must announce that the plan was updated");
    const sessionOpenPlan=page.locator("#sessionOpenPlan");
    if(await sessionOpenPlan.count()){
      await sessionOpenPlan.waitFor({state:"visible"});
      assert.equal(new URL(await sessionOpenPlan.getAttribute("href"),BASE_URL).pathname,"/planner.html","Session Builder plan link must open the planner");
      positive((await accessibleName(sessionOpenPlan)).length,"Session Builder plan-link accessible name");
      snapshot.sessionOpenPlan=true;
    }else snapshot.sessionOpenPlan=false;
    await capture(page,"session-builder-saved-desktop.png",{fullPage:false});

    await page.setViewportSize({width:390,height:844});
    await page.goto(`${BASE_URL}/planner.html`,{waitUntil:"networkidle"});
    const plannerMobileNav=await page.locator(".planner-primary-nav-mobile").evaluate((node)=>{const rect=node.getBoundingClientRect();return{top:rect.top,bottom:rect.bottom,viewport:innerHeight,position:getComputedStyle(node).position};});
    assert.equal(plannerMobileNav.position,"fixed");assert.ok(Math.abs(plannerMobileNav.viewport-plannerMobileNav.bottom)<=1,`Planner mobile navigation must stay at the viewport bottom, not ${plannerMobileNav.top}px from the top`);
    await capture(page,"planner-mobile.png",{fullPage:false});
    await page.goto(`${BASE_URL}/workout.html?day=${encodeURIComponent(snapshot.sessionChoices.day.value)}`,{waitUntil:"networkidle"});
    const workoutMobileNav=await page.locator(".workout-nav-mobile").evaluate((node)=>{const rect=node.getBoundingClientRect();return{bottom:rect.bottom,viewport:innerHeight,position:getComputedStyle(node).position};});
    assert.equal(workoutMobileNav.position,"fixed");assert.ok(Math.abs(workoutMobileNav.viewport-workoutMobileNav.bottom)<=1,"Workout mobile navigation must stay at the viewport bottom");
    await capture(page,"workout-mobile.png",{fullPage:false});

    const responsiveRoutes=["/","/account.html","/verify-email.html","/forgot-password","/reset-password","/delete-account","/planner.html","/discover.html",`/workout.html?day=${encodeURIComponent(snapshot.sessionChoices.day.value)}`,"/onboarding.html","/pricing","/contact","/policies","/terms","/privacy","/refunds","/offline.html","/install.html"];
    const responsiveContainers=".exercise-row,.library-card,.scheduled-card,.recommend-card,.exercise-card,.session-result-card,.progress-metric-grid article,.feature-block,.auth-panel,.signed-in-card,.account-next-card,.account-week-card,.account-insight-card,.price-card,.free-card,.policy-card,.contact-card,.device-card,.today-context-card,.training-block-card,.progression-card,.plan-summary-card,.stat-card";
    snapshot.responsiveLayout={};
    for(const width of [768,700,600,430,390,360,339,320]){
      await page.setViewportSize({width,height:Math.max(700,Math.round(width*1.5))});snapshot.responsiveLayout[width]={routes:responsiveRoutes.length,maxOverflow:0,textIssues:0};
      for(const route of responsiveRoutes){
        await page.goto(`${BASE_URL}${route}`,{waitUntil:"networkidle"});await page.evaluate(()=>document.fonts?.ready);
        const [overflow,textIssues]=await Promise.all([horizontalOverflow(page),textOutsideContainers(page,responsiveContainers)]);
        snapshot.responsiveLayout[width].maxOverflow=Math.max(snapshot.responsiveLayout[width].maxOverflow,overflow);snapshot.responsiveLayout[width].textIssues+=textIssues.length;
        assert.ok(overflow<=1,`${route} overflows a ${width}px viewport by ${overflow}px`);
        assert.deepEqual(textIssues,[],`${route} has text outside a content card at ${width}px: ${textIssues.join(", ")}`);
        if(width===320&&route==="/pricing")await capture(page,"pricing-mobile-320.png",{fullPage:true});
        if(width===320&&route==="/policies")await capture(page,"policies-mobile-320.png",{fullPage:true});
        if(width===320&&route==="/terms")await capture(page,"terms-mobile-320.png",{fullPage:true});
      }
    }
    assert.equal(await page.locator(".device-card").count(),4,"Install guide should cover four device paths");
    assert.equal(await page.locator(".device-card.recommended").count(),1,"Install guide should identify the current device path");
    const smallInstallTargets=await page.locator(".install-header a,.install-actions a,.install-actions button").evaluateAll((nodes)=>nodes.filter((node)=>{
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
      return style.display!=="none"&&!node.hidden&&(rect.width<44||rect.height<44);
    }).map((node)=>node.textContent.trim()));
    assert.deepEqual(smallInstallTargets,[],`Install controls below 44px: ${smallInstallTargets.join(", ")}`);
    await capture(page,"install-mobile-320.png",{fullPage:true});

    await page.goto(`${BASE_URL}/`,{waitUntil:"networkidle"});
    let reachedSearch=false;
    for(let stop=0;stop<30&&!reachedSearch;stop+=1){
      await page.keyboard.press("Tab");
      reachedSearch=await page.evaluate(()=>document.activeElement?.id==="searchInput");
    }
    assert.equal(reachedSearch,true,"The exercise search must remain in the mobile keyboard order");
    await page.waitForFunction(()=>{
      const control=document.querySelector("#searchInput")?.getBoundingClientRect(),nav=document.querySelector(".mobile-public-nav")?.getBoundingClientRect();
      return Boolean(control&&nav&&control.bottom<=nav.top);
    },undefined,{timeout:2000});
    const focusNavOverlap=await page.evaluate(()=>{
      const control=document.querySelector("#searchInput")?.getBoundingClientRect(),nav=document.querySelector(".mobile-public-nav")?.getBoundingClientRect();
      return control&&nav?Math.max(0,control.bottom-nav.top):Infinity;
    });
    assert.equal(focusNavOverlap,0,"The fixed mobile navigation must not cover a keyboard-focused control");
    snapshot.focusNavOverlap=focusNavOverlap;

    await page.goto(`${BASE_URL}/workout.html?day=${encodeURIComponent(snapshot.sessionChoices.day.value)}`,{waitUntil:"networkidle"});
    await page.keyboard.press("Tab");
    const workoutSkipReachable=await page.locator(".skip-link").evaluate((link)=>{
      const rect=link.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      return document.activeElement===link&&(hit===link||link.contains(hit));
    });
    assert.equal(workoutSkipReachable,true,"The first workout Tab stop must be visible above the sticky header");
    snapshot.workoutSkipReachable=workoutSkipReachable;

    snapshot.errors=errors;
    assert.deepEqual(errors,[],`Browser errors detected:\n${errors.join("\n")}`);
    process.stdout.write(`${JSON.stringify(snapshot,null,2)}\n`);
  }finally{
    await browser?.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
