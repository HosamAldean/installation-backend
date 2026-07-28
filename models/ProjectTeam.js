// backend/models/ProjectTeam.js
// IIT_Petra.projectTeam — join table between project and (Petra) users,
// used by Project's /:id/team endpoints. See Migration Blueprint §07.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const ProjectTeam = sequelize2PetraErp.define('ProjectTeam', {
    projectTeamId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    teamClassId: { type: DataTypes.INTEGER, allowNull: false },
}, {
    tableName: 'projectTeam',
    timestamps: false,
});

export default ProjectTeam;
