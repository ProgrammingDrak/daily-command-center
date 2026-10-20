// Domain-neutral explicit navigation. No clocks, speech, results or side effects.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PromptedSequence=factory();})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  function transition(length,current,command){
    const fail=message=>{throw Object.assign(new Error(message),{statusCode:400});};
    if(!Number.isInteger(length)||length<1)fail('Add steps before opening guidance');
    if(command==='begin'){if(current)fail('Guidance has already begun');return {status:'active',stepIndex:0};}
    if(!current)fail('Begin guidance first');
    const next={...current};
    if(command==='resume'){if(next.status!=='paused')fail('Guidance is not paused');next.status='active';return next;}
    if(next.status!=='active')fail('Resume guidance before navigating');
    if(command==='next'){if(next.stepIndex>=length-1)fail('Finish at the final card');next.stepIndex++;}
    else if(command==='back'){if(next.stepIndex===0)fail('Already at the first card');next.stepIndex--;}
    else if(command==='exit')next.status='paused';
    else if(command==='finish'){if(next.stepIndex!==length-1)fail('Continue to the final card before finishing');next.status='finished';}
    else fail('Unknown guidance action');
    return next;
  }
  return {transition};
});
