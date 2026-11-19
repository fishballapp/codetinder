import { createFileRoute } from '@tanstack/react-router';
import { RoundPage } from '../round/RoundPage';

const RouteComponent = () => {
  const { id } = Route.useParams();
  return <RoundPage id={id} />;
};

export const Route = createFileRoute('/rounds/$id')({ component: RouteComponent });
