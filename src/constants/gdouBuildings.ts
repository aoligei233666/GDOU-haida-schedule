/**
 * Pure offline Guangdong Ocean University (GDOU) campus building & classroom quick-reference guide.
 * Helps freshmen and cross-building students immediately locate classrooms across
 * Huguang (湖光), Yangjiang (阳江), Haibin (海滨), and Xiashan (霞山) campuses with zero network calls.
 */

export interface GdouBuildingInfo {
  id: string;
  name: string;
  campus: string;
  zone: string;
  keywords: string[];
  floorHint: string;
  walkTip: string;
}

export const GDOU_BUILDINGS: readonly GdouBuildingInfo[] = [
  {
    id: 'huguang-zhonghai',
    name: '钟海楼',
    campus: '湖光校区',
    zone: '教学核心区（东侧主教学楼）',
    keywords: ['钟海楼', '钟海', 'ZHL', '030', '040', '050'],
    floorHint: '通常前两位数字对应楼层/区号（如 03012 为 3 楼西/南区教室），大型阶梯教室分布在中低楼层',
    walkTip: '紧邻主楼广场与西区/东区通道，课间从主楼步行约 3-5 分钟，早八高峰电梯较拥挤建议走楼梯',
  },
  {
    id: 'huguang-zhulou',
    name: '主楼（教学主楼）',
    campus: '湖光校区',
    zone: '中轴线核心区',
    keywords: ['主楼', '教学主楼', 'ZL'],
    floorHint: '分东/中/西区与多层公共大教室，注意核对“主楼多功能厅/多媒体教室”编号',
    walkTip: '位于湖光校区正门中轴线，距图书馆步行约 4 分钟，距第三/第四饭堂约 6-8 分钟',
  },
  {
    id: 'huguang-boxue',
    name: '博学楼',
    campus: '湖光校区',
    zone: '中区教学楼群',
    keywords: ['博学楼', '博学', 'BXL'],
    floorHint: '常见公共基础课、思政课与语音/多媒体教室，房间号首位一般表示楼层',
    walkTip: '毗邻广学楼与主楼，从海宁/海安/海韵宿舍区步行约 8-12 分钟',
  },
  {
    id: 'huguang-guangxue',
    name: '广学楼',
    campus: '湖光校区',
    zone: '中区教学楼群（近博学楼）',
    keywords: ['广学楼', '广学', 'GXL'],
    floorHint: '集中安排公共课、计算机机房及专业基础课，机房大多集中在指定楼层',
    walkTip: '与博学楼相邻，两楼之间课间换场仅需 2-3 分钟',
  },
  {
    id: 'huguang-xingnong',
    name: '兴农楼',
    campus: '湖光校区',
    zone: '农学/生物/食品实验教学区',
    keywords: ['兴农楼', '兴农', '农学'],
    floorHint: '以农学、食品、生物类专业实验室与专业课教室为主，实验课请提前 10 分钟到达穿戴实验服',
    walkTip: '距钟海楼步行约 6-8 分钟，跨楼连堂建议预留充足步行时间',
  },
  {
    id: 'huguang-keji',
    name: '科技楼 / 海科楼',
    campus: '湖光校区',
    zone: '理工与海洋科学实验区',
    keywords: ['科技楼', '海科楼', '海洋科技楼', '水产楼', '海资'],
    floorHint: '包含海洋科学、水产、理工学院专业教室、科研实验室及机房',
    walkTip: '靠近湖光湖畔与主楼侧翼，距东区宿舍较近、距西区宿舍步行约 10-15 分钟',
  },
  {
    id: 'huguang-shiyan',
    name: '综合实验楼 / 工程训练中心',
    campus: '湖光校区',
    zone: '实验实训与金工实习区',
    keywords: ['实验楼', '综合实验', '工程训练', '实训', '机房', '计算中心', '电工电子'],
    floorHint: '物理/化学/电工/金工/计算机上机实验教室，上机或实训课留意分批与安全着装要求',
    walkTip: '距离公共教学楼有一定距离，建议课前提前 15 分钟出发或骑校内单车',
  },
  {
    id: 'huguang-tiyu',
    name: '体育馆 / 东区西区运动场 / 游泳馆',
    campus: '湖光校区',
    zone: '体育教学区',
    keywords: ['体育馆', '运动场', '田径场', '篮球场', '排球场', '网球场', '游泳馆', '乒乓球', '羽毛球', '操场'],
    floorHint: '室外体育课雨天通常改至体育馆内或通知群指定教室，请穿运动鞋服',
    walkTip: '注意区分东区运动场与西区运动场，避免跑错半区',
  },
  {
    id: 'huguang-yishu',
    name: '中歌艺术学院楼 / 文科楼',
    campus: '湖光校区',
    zone: '艺术与人文教学区',
    keywords: ['中歌', '艺术', '音乐厅', '琴房', '舞蹈', '文科楼', '法政', '经管'],
    floorHint: '含艺术排练厅、画室、琴房及人文社科专业教室',
    walkTip: '位于湖光校区相对静谧片区，距钟海楼步行约 7-10 分钟',
  },
  {
    id: 'yangjiang-haina',
    name: '海纳楼（教学主楼）',
    campus: '阳江校区',
    zone: '阳江校区核心教学区',
    keywords: ['海纳楼', '海纳'],
    floorHint: '阳江校区核心公共教学楼，编号前段对应分区与楼层，多媒体与阶梯教室集中在此',
    walkTip: '阳江校区实行 08:20 作息，从学生公寓步行至海纳楼约 8-12 分钟',
  },
  {
    id: 'yangjiang-houwei',
    name: '厚为楼 / 弘德楼 / 崇实楼',
    campus: '阳江校区',
    zone: '阳江校区专业学院与实验区',
    keywords: ['厚为楼', '弘德楼', '崇实楼', '阳江'],
    floorHint: '阳江校区工科/商科/食品专业课教室、机房及综合实验室',
    walkTip: '与海纳楼同处教学片区，跨楼步行约 4-6 分钟',
  },
  {
    id: 'haibin-main',
    name: '海滨校区教学楼 / 航海实验楼',
    campus: '海滨校区',
    zone: '湛江海滨校区（航海/轮机/船海）',
    keywords: ['海滨', '航海楼', '轮机', '船海'],
    floorHint: '海滨校区面积紧凑，教学楼与航海模拟器/实验室均在步行 5 分钟圈内',
    walkTip: '校内步行距离短，请核对具体楼层与实验室门牌',
  },
  {
    id: 'xiashan-main',
    name: '霞山校区教学楼',
    campus: '霞山校区',
    zone: '湛江霞山老校区',
    keywords: ['霞山', '寸金'],
    floorHint: '霞山校区教学楼与继续教育/专业课教室集中在主院区内',
    walkTip: '跨湖光与霞山校区通勤需预留 45-60 分钟公交/校车时间',
  },
];

export function lookupGdouBuildingGuide(
  locationText?: string | null,
  campusHint?: string | null
): GdouBuildingInfo | null {
  const loc = String(locationText ?? '').trim();
  const campus = String(campusHint ?? '').trim();
  if (!loc && !campus) return null;

  const combined = `${campus} ${loc}`.toUpperCase();
  // First pass: exact Chinese building name or explicit keyword match on location
  for (const b of GDOU_BUILDINGS) {
    for (const kw of b.keywords) {
      if (loc.toUpperCase().includes(kw.toUpperCase())) {
        return b;
      }
    }
  }
  // Second pass: campus + location match
  for (const b of GDOU_BUILDINGS) {
    if (campus && b.campus.includes(campus) && b.keywords.some((kw) => combined.includes(kw.toUpperCase()))) {
      return b;
    }
  }
  return null;
}
