// celebrate.js -- lightweight, dependency-free celebration effects.
// Exposes window.Celebrate:
//   Celebrate.confetti({x, y, flowTo, count, colors, onArrive})
//       Confetti erupts from (x, y). With flowTo:{x,y} the particles whirlwind
//       together and stream into that target (the points counter), and onArrive
//       fires once the swarm reaches it. Without flowTo they fall under gravity.
//   Celebrate.countNumber(el, from, to, {duration, format})
//       Tween a number into an element's textContent (ease-out).
// Both honor prefers-reduced-motion: confetti is skipped (onArrive still fires
// immediately so points still update) and the count snaps to its final value.
(function(){
  "use strict";

  var COLORS = ["#f59e0b","#22c55e","#3b82f6","#a78bfa","#ef4444","#fbbf24","#34d399"];
  var canvas = null, ctx = null, dpr = 1;
  var particles = [];
  var rafId = null, lastTs = 0;
  // Tracks the in-flight "flow into the points" swarm so its onArrive callback
  // fires exactly once when the bulk of the confetti has reached the target.
  var flow = null;

  function reducedMotion(){
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch(e){ return false; }
  }
  function now(){
    return (window.performance && performance.now) ? performance.now() : new Date().getTime();
  }

  function ensureCanvas(){
    if(canvas) return canvas;
    canvas = document.createElement("canvas");
    canvas.id = "celebrate-canvas";
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:99999;";
    canvas.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(canvas);
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize, { passive: true });
    return canvas;
  }

  function resize(){
    if(!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    if(ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rand(min, max){ return min + Math.random() * (max - min); }

  function spawn(opts){
    opts = opts || {};
    var x = opts.x != null ? opts.x : window.innerWidth / 2;
    var y = opts.y != null ? opts.y : window.innerHeight / 3;
    var count = opts.count != null ? opts.count : 90;
    var colors = opts.colors || COLORS;
    var flowTo = opts.flowTo || null;

    for(var i = 0; i < count; i++){
      var angle = rand(0, Math.PI * 2);
      var speed = rand(3, 9);
      var size = rand(5, 11);
      particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - rand(1, 4), // slight upward bias on the burst
        w: size, h: size * rand(0.45, 0.75),
        color: colors[(Math.random() * colors.length) | 0],
        rot: rand(0, Math.PI * 2),
        vr: rand(-0.35, 0.35),
        life: 1,
        decay: rand(0.008, 0.016),
        shape: Math.random() < 0.25 ? "circle" : "rect",
        // Flow ("whirlwind into the points") fields:
        flow: !!flowTo,
        tx: flowTo ? flowTo.x : 0,
        ty: flowTo ? flowTo.y : 0,
        spin: Math.random() < 0.82 ? 1 : -1,   // mostly one direction -> a coherent whirlwind
        age: 0,
        // Non-flow confetti falls under gravity instead.
        gravity: rand(0.18, 0.3),
        drag: 0.985
      });
    }

    if(flowTo){
      flow = {
        onArrive: typeof opts.onArrive === "function" ? opts.onArrive : null,
        fired: false,
        total: count,
        arrived: 0,
        startedAt: now()
      };
    }
  }

  function maybeFireArrive(){
    if(!flow || flow.fired) return;
    var elapsed = now() - flow.startedAt;
    // Fire when the bulk of the swarm has reached the target, or as a safety
    // net once enough time has passed so the points always update.
    if(flow.arrived >= flow.total * 0.45 || elapsed > 1100){
      flow.fired = true;
      var cb = flow.onArrive;
      if(cb){ try { cb(); } catch(e){} }
    }
  }

  function stepFlow(p, dt){
    p.age += dt * 16.6667;
    // Kill the initial outward burst quickly so particles gather, then swirl in.
    p.vx *= 0.9; p.vy *= 0.9;
    var dx = p.tx - p.x, dy = p.ty - p.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist, uy = dy / dist;
    // Radial pull ramps in over the first ~280ms and strengthens as it nears.
    var pull = 0.85 * Math.min(1, p.age / 280) * (1 + (1 - Math.min(1, dist / 360)) * 1.6);
    // Tangential swirl gives the whirlwind; it eases off near the center so the
    // particles fall into the target instead of orbiting it forever.
    var swirl = 1.1 * p.spin * Math.min(1, dist / 70);
    p.vx += ux * pull + (-uy) * swirl;
    p.vy += uy * pull + (ux) * swirl;
    // Cap speed so nothing slingshots past the target.
    var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    var max = 26;
    if(sp > max){ p.vx = p.vx / sp * max; p.vy = p.vy / sp * max; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.rot += p.vr * dt * 1.6;
    if(dist < 26){
      // Absorbed into the points counter: shrink and wink out.
      p.life -= 0.16 * dt;
      p.w *= 0.88; p.h *= 0.88;
      if(p.life <= 0 || p.w < 1){
        p.life = 0;
        if(flow) flow.arrived++;
      }
    } else if(p.age > 2600){
      // Hard stop so a stray particle can't keep the loop alive.
      p.life = 0;
      if(flow) flow.arrived++;
    }
  }

  function stepFall(p, dt){
    p.vy += p.gravity * dt;
    p.vx *= Math.pow(p.drag, dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life -= p.decay * dt;
    if(p.life <= 0 || p.y - 40 > window.innerHeight) p.life = 0;
  }

  function frame(ts){
    if(!ctx){ rafId = null; return; }
    var dt = lastTs ? Math.min((ts - lastTs) / 16.6667, 2.5) : 1; // normalize to ~60fps
    lastTs = ts;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var alive = 0;
    for(var i = 0; i < particles.length; i++){
      var p = particles[i];
      if(p.life <= 0) continue;
      if(p.flow) stepFlow(p, dt); else stepFall(p, dt);
      if(p.life <= 0) continue;
      alive++;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if(p.shape === "circle"){
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }

    maybeFireArrive();

    if(alive > 0){
      rafId = window.requestAnimationFrame(frame);
    } else {
      // Make sure a callback fires even if everything expired at once.
      if(flow && !flow.fired){ flow.fired = true; if(flow.onArrive){ try{ flow.onArrive(); }catch(e){} } }
      particles.length = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      rafId = null;
      lastTs = 0;
      flow = null;
    }
  }

  function confetti(opts){
    opts = opts || {};
    if(reducedMotion()){
      // No animation, but still let the caller update the points immediately.
      if(typeof opts.onArrive === "function"){ try { opts.onArrive(); } catch(e){} }
      return;
    }
    if(!document.body){
      document.addEventListener("DOMContentLoaded", function(){ confetti(opts); }, { once: true });
      return;
    }
    ensureCanvas();
    spawn(opts);
    if(rafId == null){
      lastTs = 0;
      rafId = window.requestAnimationFrame(frame);
    }
  }

  function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }

  function countNumber(el, from, to, opts){
    if(!el) return;
    opts = opts || {};
    var fmt = typeof opts.format === "function" ? opts.format : function(v){ return String(v); };
    from = Number(from); to = Number(to);
    if(!isFinite(from)) from = 0;
    if(!isFinite(to)) to = from;
    if(reducedMotion() || from === to){
      el.textContent = fmt(to);
      return;
    }
    var duration = opts.duration != null ? opts.duration : 750;
    var start = now();
    var token = (el._celebrateToken = (el._celebrateToken || 0) + 1);
    function step(){
      if(el._celebrateToken !== token) return; // a newer count-up superseded this one
      var elapsed = now() - start;
      var t = Math.min(1, elapsed / duration);
      var value = Math.round(from + (to - from) * easeOutCubic(t));
      el.textContent = fmt(value);
      if(t < 1) window.requestAnimationFrame(step);
      else el.textContent = fmt(to);
    }
    window.requestAnimationFrame(step);
  }

  window.Celebrate = {
    confetti: confetti,
    countNumber: countNumber,
    colors: COLORS
  };
})();
