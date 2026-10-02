(() => {
  const root = document.getElementById("earth-journey"),
    $ = (s) => root.querySelector(s),
    $$ = (s) => Array.from(root.querySelectorAll(s));
  const canvas = $("canvas"),
    c = canvas.getContext("2d");
  let face = 0,
    sound = false,
    audio = null,
    selected = 0,
    rewardTimer = null,
    returnFocus = null;
  const skin = "#d6ad8e",
    dark = "#202a2b",
    light = "#f5efdf";
  function path(points, fill, stroke) {
    c.beginPath();
    for (const p of points) {
      const [op, ...v] = p;
      if (op === "M") c.moveTo(...v);
      if (op === "L") c.lineTo(...v);
      if (op === "C") c.bezierCurveTo(...v);
      if (op === "Q") c.quadraticCurveTo(...v);
      if (op === "Z") c.closePath();
    }
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 3;
      c.stroke();
    }
  }
  function draw() {
    c.clearRect(0, 0, 640, 800);
    path(
      [
        ["M", 203, 793],
        ["L", 210, 609],
        ["L", 420, 608],
        ["L", 482, 800],
        ["Z"],
      ],
      dark,
    );
    path(
      [
        ["M", 333, 643],
        ["L", 321, 800],
      ],
      null,
      "#536164",
    );
    path(
      [
        ["M", 234, 318],
        ["Q", 169, 316, 142, 390],
        ["L", 88, 632],
        ["L", 166, 660],
        ["L", 228, 486],
        ["L", 239, 650],
        ["Q", 335, 690, 454, 640],
        ["L", 418, 460],
        ["L", 480, 610],
        ["L", 546, 585],
        ["L", 480, 378],
        ["Q", 451, 310, 383, 308],
        ["Z"],
      ],
      dark,
      "#101b1d",
    );
    path(
      [
        ["M", 273, 311],
        ["L", 359, 306],
        ["L", 409, 634],
        ["Q", 327, 659, 257, 634],
        ["Z"],
      ],
      light,
    );
    path(
      [
        ["M", 274, 263],
        ["L", 269, 334],
        ["Q", 317, 370, 365, 330],
        ["L", 351, 244],
        ["Z"],
      ],
      skin,
    );
    path(
      [["M", 275, 280], ["Q", 302, 330, 357, 296], ["L", 352, 263], ["Z"]],
      "#ab806b",
    );
    path(
      [
        ["M", 257, 321],
        ["L", 237, 391],
        ["L", 262, 407],
        ["L", 222, 460],
        ["L", 245, 635],
      ],
      null,
      "#617071",
    );
    path(
      [
        ["M", 373, 317],
        ["L", 411, 386],
        ["L", 389, 408],
        ["L", 433, 458],
      ],
      null,
      "#617071",
    );
    path(
      [
        ["M", 243, 158],
        ["Q", 225, 250, 268, 285],
        ["Q", 309, 321, 360, 278],
        ["Q", 400, 247, 386, 166],
        ["Q", 353, 117, 291, 126],
        ["Z"],
      ],
      skin,
      "#292c29",
    );
    path(
      [
        ["M", 242, 210],
        ["Q", 217, 192, 223, 223],
        ["Q", 226, 245, 244, 240],
      ],
      skin,
    );
    path(
      [
        ["M", 386, 205],
        ["Q", 406, 184, 409, 216],
        ["Q", 410, 237, 389, 239],
      ],
      skin,
    );
    path(
      [
        ["M", 235, 212],
        ["L", 218, 176],
        ["L", 230, 134],
        ["L", 211, 145],
        ["L", 245, 98],
        ["L", 259, 78],
        ["L", 284, 86],
        ["L", 310, 54],
        ["L", 326, 78],
        ["L", 378, 72],
        ["L", 370, 91],
        ["L", 414, 121],
        ["L", 400, 127],
        ["L", 420, 174],
        ["L", 393, 223],
        ["L", 378, 155],
        ["L", 353, 139],
        ["L", 332, 184],
        ["L", 322, 157],
        ["L", 282, 201],
        ["L", 286, 156],
        ["L", 250, 184],
        ["Z"],
      ],
      dark,
      "#151f20",
    );
    path(
      [
        ["M", 249, 123],
        ["Q", 305, 76, 366, 105],
      ],
      null,
      "#4b5c5a",
    );
    path(
      [
        ["M", 354, 111],
        ["Q", 386, 126, 393, 166],
      ],
      null,
      "#4b5c5a",
    );
    path(
      [
        ["M", 260, 215],
        ["Q", 277, 204, 294, 214],
      ],
      null,
      dark,
    );
    path(
      [
        ["M", 335, 214],
        ["Q", 353, 202, 368, 211],
      ],
      null,
      dark,
    );
    if (face % 3 === 1) {
      path(
        [
          ["M", 264, 230],
          ["Q", 277, 216, 292, 229],
        ],
        null,
        dark,
      );
      path(
        [
          ["M", 337, 226],
          ["Q", 352, 213, 365, 225],
        ],
        null,
        dark,
      );
    } else {
      c.fillStyle = dark;
      c.beginPath();
      c.ellipse(278, 225, 5, 7, 0, 0, 7);
      c.ellipse(352, 221, 5, 7, 0, 0, 7);
      c.fill();
    }
    path(
      [
        ["M", 313, 224],
        ["L", 307, 245],
        ["L", 318, 245],
      ],
      null,
      "#9a7562",
    );
    path(
      [
        ["M", 293, 267],
        ["Q", 317, face % 3 === 1 ? 287 : 275, 339, 263],
      ],
      null,
      dark,
    );
    path(
      [
        ["M", 100, 630],
        ["L", 107, 677],
        ["Q", 132, 704, 154, 677],
        ["L", 167, 651],
        ["Z"],
      ],
      skin,
      dark,
    );
    path(
      [
        ["M", 480, 607],
        ["L", 493, 644],
        ["Q", 521, 660, 537, 632],
        ["L", 539, 594],
        ["Z"],
      ],
      skin,
      dark,
    );
    path(
      [
        ["M", 174, 384],
        ["L", 138, 546],
      ],
      null,
      "#617071",
    );
    path(
      [
        ["M", 447, 389],
        ["L", 486, 536],
      ],
      null,
      "#617071",
    );
    path(
      [
        ["M", 365, 457],
        ["L", 404, 455],
        ["L", 407, 478],
        ["L", 368, 479],
        ["Z"],
      ],
      "#b7d94b",
    );
    c.fillStyle = dark;
    c.font = "bold 12px Arial";
    c.fillText("EARTH", 370, 473);
  }
  draw();
  const names = ["知识", "胆量", "灵巧", "温柔", "魅力"],
    titles = ["博识", "无畏", "熟练", "体贴", "瞩目"],
    ranks = [1, 1, 1, 1, 1],
    xp = [0, 0, 0, 0, 0],
    completed = new Set();
  const activities = [
    { name: "阅读 20 分钟", stat: 0, detail: "投入记录 · 不等同于能力掌握" },
    { name: "练习和弦 15 分钟", stat: 2, detail: "主线：独立弹唱一首歌" },
    { name: "给朋友一次认真回应", stat: 3, detail: "支线：留一点时间给关系" },
  ];
  const vertices = (r) =>
    Array.from({ length: 5 }, (_, i) => {
      let a = ((-90 + i * 72) * Math.PI) / 180;
      return [165 + Math.cos(a) * r, 110 + Math.sin(a) * r];
    });
  const ns = "http://www.w3.org/2000/svg";
  [1, 2, 3, 4, 5].forEach((k) => {
    let p = document.createElementNS(ns, "polygon");
    p.setAttribute(
      "points",
      vertices(k * 13)
        .map((p) => p.join(","))
        .join(" "),
    );
    $(".grid").append(p);
  });
  vertices(65).forEach((p) => {
    let l = document.createElementNS(ns, "line");
    l.setAttribute("x1", 165);
    l.setAttribute("y1", 110);
    l.setAttribute("x2", p[0]);
    l.setAttribute("y2", p[1]);
    $(".grid").append(l);
  });
  function radar() {
    let pts = ranks.map((r, i) => {
      let a = ((-90 + i * 72) * Math.PI) / 180,
        t = (r + xp[i] / 20) * 13;
      return [165 + Math.cos(a) * t, 110 + Math.sin(a) * t];
    });
    $(".shape").setAttribute("points", pts.map((p) => p.join(",")).join(" "));
    $(".dots").replaceChildren();
    pts.forEach((p, i) => {
      let el = document.createElementNS(ns, "circle");
      el.setAttribute("cx", p[0]);
      el.setAttribute("cy", p[1]);
      el.setAttribute("r", selected === i ? 4 : 2.5);
      $(".dots").append(el);
    });
    $$(".stat").forEach((b, i) => {
      b.classList.toggle("selected", i === selected);
      b.setAttribute("aria-pressed", i === selected ? "true" : "false");
      b.querySelector("span").textContent =
        "RANK " + ranks[i] + " · " + titles[i];
    });
    $(".radar").setAttribute(
      "aria-label",
      names.map((n, i) => n + ranks[i]).join("，"),
    );
  }
  radar();
  function tone() {
    if (!sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      audio.resume();
      const o = audio.createOscillator(),
        g = audio.createGain();
      o.connect(g);
      g.connect(audio.destination);
      o.frequency.setValueAtTime(520, audio.currentTime);
      o.frequency.exponentialRampToValueAtTime(850, audio.currentTime + 0.08);
      g.gain.setValueAtTime(0.035, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.13);
      o.start();
      o.stop(audio.currentTime + 0.14);
    } catch (e) {
      sound = false;
    }
  }
  $(".sound").onclick = () => {
    sound = !sound;
    $(".sound").setAttribute(
      "aria-label",
      sound ? "关闭交互音效" : "启用交互音效",
    );
    $(".sound").innerHTML =
      '<i data-lucide="' + (sound ? "volume-2" : "volume-x") + '"></i>';
    if (window.lucide) lucide.createIcons();
    tone();
  };
  const sayings = [
    "不用把每一天，都安排得满满当当。",
    "试试看。故事才刚刚开始。",
    "今天，想把时间花在哪里？",
  ];
  $(".portrait").onclick = () => {
    face++;
    draw();
    $(".speech").textContent = sayings[(face - 1) % sayings.length];
    $(".portrait").classList.remove("react");
    void $(".portrait").offsetWidth;
    $(".portrait").classList.add("react");
    tone();
  };

  window.earthArt = {
    update(values, perRank) {
      values.forEach((v, i) => {
        ranks[i] = Math.min(5, 1 + Math.floor(v / perRank));
        xp[i] = ranks[i] === 5 ? 0 : ((v % perRank) * 20) / perRank;
      });
      radar();
    },
    select(i) {
      selected = i;
      radar();
    },
    names,
  };
})();
