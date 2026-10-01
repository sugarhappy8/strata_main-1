/* global module, require */
(function(root,factory){
  const entitlements=typeof module==="object"&&module.exports?require("./entitlements"):root.StrataEntitlements;
  const api=factory(entitlements);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPricingLogic=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(entitlements){
  "use strict";

  const RETIRED_PRODUCT_ID="pro_01m1ky8j916ybyacs836dxbz8x";
  const RETIRED_ONE_TIME_PRICE_ID="pri_01m1kyc2zd313d7a3ssmg02424";

  function discoveryIsActive(user){return entitlements.can(user,"plus.studio");}
  function subscriptionFor(user){
    const subscription=user?.discovery?.subscription;
    return subscription&&typeof subscription==="object"&&subscription.id?subscription:null;
  }
  function paidAccessType(user){return user?.discovery?.accessType==="paid";}
  function paidAccessReady(user){return subscriptionFor(user)?.active===true||paidAccessType(user);}
  function billingDate(value){
    const timestamp=Number(value),date=new Date(timestamp);
    return Number.isFinite(timestamp)&&timestamp>0&&!Number.isNaN(date.getTime())?date.toLocaleDateString([],{dateStyle:"medium"}):"the date Paddle shows";
  }
  function checkoutTransactionId(data){return String(data?.transactionId||data?.transaction_id||data?.id||"");}

  // Strata+ bought in the iOS app is billed and managed by Apple; the website names it and links to Apple's page.
  const APPLE_MANAGE_URL="https://apps.apple.com/account/subscriptions";
  function appleAccess(user){const apple=user?.discovery?.apple;return user?.discovery?.accessType==="apple"&&apple&&typeof apple==="object"?apple:null;}
  function appleStatus(apple){
    const date=Number(apple?.expiresAt)>0?billingDate(apple.expiresAt):"";
    if(apple?.inGracePeriod===true)return{tone:"warn",message:"Your Strata+ is through the App Store. Apple could not collect the latest payment; update your Apple Account’s payment method to keep it."};
    if(apple?.autoRenew===false)return{tone:"warn",message:`Your Strata+ is through the App Store and ends${date?` on ${date}`:""}. It will not renew unless you resubscribe with Apple.`};
    return{tone:"good",message:`Your Strata+ is through the App Store${date?` and renews on ${date}`:""}. Apple bills it, so manage or cancel it with your App Store subscriptions.`};
  }

  function normalizedConfig(data){
    const config=data?.billing&&typeof data.billing==="object"?data.billing:data;
    return{
      enabled:config?.enabled!==false&&config?.configured!==false,
      environment:String(config?.environment||config?.mode||"live").toLowerCase(),
      clientToken:String(config?.clientToken||config?.client_token||config?.token||""),
      productId:String(config?.productId||config?.product_id||config?.product||""),
      priceId:String(config?.priceId||config?.price_id||(typeof config?.price==="string"?config.price:"")||""),
      price:{
        amount:String(config?.price?.amount||""),currency:String(config?.price?.currency||"").toUpperCase(),
        interval:String(config?.price?.interval||"").toLowerCase(),frequency:Number(config?.price?.frequency)
      }
    };
  }

  function validateConfig(config){
    if(!config.enabled)throw new Error("Secure checkout is temporarily unavailable.");
    const sandbox=config.environment==="sandbox";
    if(!["live","production","sandbox"].includes(config.environment))throw new Error("Checkout has an unsupported Paddle environment.");
    if(!config.clientToken.startsWith(sandbox?"test_":"live_"))throw new Error("Checkout credentials do not match the Paddle environment.");
    if(sandbox){
      if(!/^pro_[a-z0-9]{20,}$/.test(config.productId)||!/^pri_[a-z0-9]{20,}$/.test(config.priceId)||config.productId===RETIRED_PRODUCT_ID||config.priceId===RETIRED_ONE_TIME_PRICE_ID)throw new Error("Sandbox checkout requires its own recurring test product and price.");
    }else{
      if(!/^pro_[a-z0-9]{20,}$/.test(config.productId))throw new Error("The configured Strata+ product is invalid.");
      if(!/^pri_[a-z0-9]{20,}$/.test(config.priceId)||config.priceId===RETIRED_ONE_TIME_PRICE_ID)throw new Error("The configured Strata+ price is not the current recurring price.");
    }
    if(config.price.amount!=="2.99"||config.price.currency!=="USD"||config.price.interval!=="month"||config.price.frequency!==1)throw new Error("Checkout pricing does not match $2.99 USD per month.");
    return config;
  }

  return{RETIRED_PRODUCT_ID,RETIRED_ONE_TIME_PRICE_ID,APPLE_MANAGE_URL,appleAccess,appleStatus,billingDate,checkoutTransactionId,discoveryIsActive,normalizedConfig,paidAccessReady,paidAccessType,subscriptionFor,validateConfig};
});
