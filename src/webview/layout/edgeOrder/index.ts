/**
 * On-demand A* obstacle-avoiding edge router (spec 05 §9). PURE engine barrel — exports the
 * framework-free router + its types only. NO store / history / persistence / EdgeLayout imports:
 * the runner adapter (`smartLayout/runner.ts`) maps `RoutedEdge[]` onto `EdgeLayout`.
 */
export { orderEdges, routeOneEdge, chooseSides4 } from './astar';
export type { OrderEdgeInput, OrderEdgesOptions, RoutedEdge, PortPoint, Side } from './astar';
export { buildRouteGrid, RouteGrid, WorldUsage } from './grid';
export type { Cell } from './grid';
export * from './constants';
