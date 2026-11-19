import { createFileRoute } from '@tanstack/react-router';
import { ProjectPage } from '../projects/ProjectPage';

const RouteComponent = () => {
  const { id } = Route.useParams();
  return <ProjectPage id={id} />;
};

export const Route = createFileRoute('/projects/$id')({ component: RouteComponent });
