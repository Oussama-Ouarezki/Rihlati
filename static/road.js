/**
 * The programme's road.
 *
 * One curve per `[data-road]`, drawn through its `[data-road-pin]` centres so
 * the road always meets its pins however tall the cards are. Card heights come
 * from real content, so this cannot be hand-coordinated in CSS the way the
 * fixed-row roadmap is; measuring is the point.
 *
 * The script is decoration, not structure: the steps, their text and their
 * emoji all render without it, over a straight band that `styles/input.css`
 * draws. If this file fails to load, the page is a straight road, not a
 * broken page.
 */
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  /** A cubic through every point, vertical at each one — the same shape the
   *  roadmap uses, for the same reason: a curve that leaves and enters each
   *  stop straight down reads as a road rather than a scribble. */
  function roadPath(points, height) {
    if (!points.length) return "";

    var d = "M " + points[0].x + " 0";
    var previous = { x: points[0].x, y: 0 };

    points.forEach(function (point) {
      var third = (point.y - previous.y) / 3;
      d +=
        " C " + previous.x + " " + (previous.y + third) +
        " " + point.x + " " + (point.y - third) +
        " " + point.x + " " + point.y;
      previous = point;
    });

    // Straight down to the edge: the curve already arrives vertical, so the
    // exit continues it rather than starting a new shape.
    return d + " L " + previous.x + " " + height;
  }

  function stroke(d, colour, width, opacity, dash) {
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", colour);
    path.setAttribute("stroke-width", width);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-opacity", opacity);
    if (dash) {
      path.setAttribute("stroke-dasharray", dash);
      // The dashes travel downward, the direction of travel.
      path.setAttribute("class", "road-flow");
    }
    return path;
  }

  /** Where the road is at a given height. The curve leaves and enters every
   *  pin vertically, so between two pins x moves almost linearly with y —
   *  close enough to put a day sign on the line without sampling the path. */
  function xAtY(points, y) {
    if (!points.length) return 0;
    // Above the first pin and below the last, the road runs straight down.
    if (y <= points[0].y) return points[0].x;
    for (var i = 1; i < points.length; i++) {
      if (y <= points[i].y) {
        var a = points[i - 1];
        var b = points[i];
        var span = b.y - a.y;
        return span ? a.x + ((b.x - a.x) * (y - a.y)) / span : b.x;
      }
    }
    return points[points.length - 1].x;
  }

  function draw(road) {
    var pins = road.querySelectorAll("[data-road-pin]");
    if (!pins.length) return;

    var box = road.getBoundingClientRect();
    if (!box.width || !box.height) return;

    var points = [];
    for (var i = 0; i < pins.length; i++) {
      var rect = pins[i].getBoundingClientRect();
      points.push({
        x: rect.left - box.left + rect.width / 2,
        y: rect.top - box.top + rect.height / 2,
      });
    }

    var width = box.width;
    var height = box.height;
    var d = roadPath(points, height);

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "road-svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.appendChild(stroke(d, "#0f172a", 40, "0.10"));
    svg.appendChild(stroke(d, "#334155", 34, "1"));
    svg.appendChild(stroke(d, "#f8fafc", 2.5, "1", "12 12"));

    var previous = road.querySelector(".road-svg");
    if (previous) previous.remove();
    // After the band, before the steps: the cards have opaque backgrounds and
    // paint over the road, the pins paint over the road.
    road.insertBefore(svg, road.querySelector("ol"));

    // A day sign belongs on the road, not beside it. Its natural position is
    // the centre — where the CSS fallback band is — and the shift is a
    // transform, so it never changes the height the path was measured against.
    var signs = road.querySelectorAll(".road-sign");
    for (var j = 0; j < signs.length; j++) {
      var sign = signs[j];
      var signY = sign.offsetTop + sign.offsetHeight / 2;
      var signX = sign.offsetLeft + sign.offsetWidth / 2;
      sign.style.setProperty("--sign-shift", xAtY(points, signY) - signX + "px");
    }

    road.setAttribute("data-road-ready", "");
  }

  function schedule(road) {
    var frame = 0;
    return function () {
      if (frame) return;
      frame = window.requestAnimationFrame(function () {
        frame = 0;
        draw(road);
      });
    };
  }

  function init(road) {
    var redraw = schedule(road);
    redraw();

    window.addEventListener("resize", redraw);
    if (window.ResizeObserver) new ResizeObserver(redraw).observe(road);

    // Card heights move when the webfont lands, and the pins move with them.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
  }

  function start() {
    var roads = document.querySelectorAll("[data-road]");
    for (var i = 0; i < roads.length; i++) init(roads[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
